import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, MikroORM, type Options } from '@mikro-orm/postgresql';
import { MIGRATIONS } from '../../../../migrations';
import type { Logger } from '../../../application/ports/runtime.ports';
import { sleep } from '../../../shared/sleep';
import type { AppConfig } from '../../configuration/config';
import { ENTITY_SCHEMAS } from './records';

interface PgConnection {
  query(text: string, callback: (error: Error | null) => void): void;
}

export interface OrmOptions {
  applicationName: string;
  /** Registers the Migrator extension (migration entrypoint and tests only). */
  withMigrator?: boolean;
}

/**
 * Every pooled connection is initialised with UTC and bounded waits:
 *  - lock_timeout: a request never waits forever behind a hot wallet;
 *  - statement_timeout: no runaway query holds a lock;
 *  - idle_in_transaction_session_timeout: a stuck client cannot pin row locks.
 */
export function mikroOrmOptions(database: AppConfig['database'], options: OrmOptions): Options {
  const sessionSetup = [
    `SET TIME ZONE 'UTC'`,
    `SET lock_timeout = ${Math.trunc(database.lockTimeoutMs)}`,
    `SET statement_timeout = ${Math.trunc(database.statementTimeoutMs)}`,
    `SET idle_in_transaction_session_timeout = ${Math.trunc(database.idleInTransactionTimeoutMs)}`,
  ].join('; ');

  return defineConfig({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    dbName: database.name,
    entities: ENTITY_SCHEMAS,
    discovery: { disableDynamicFileAccess: true, requireEntitiesArray: true, warnWhenNoEntities: false },
    forceUtcTimezone: true,
    allowGlobalContext: false,
    ensureDatabase: false,
    debug: database.debug,
    pool: {
      min: database.poolMin,
      max: database.poolMax,
      idleTimeoutMillis: 30_000,
      afterCreate: (
        connection: PgConnection,
        done: (error: Error | null, connection: PgConnection) => void,
      ) => {
        connection.query(sessionSetup, (error) => done(error, connection));
      },
    },
    driverOptions: {
      acquireConnectionTimeout: database.acquireTimeoutMs,
      connection: {
        connectionTimeoutMillis: database.connectTimeoutMs,
        application_name: options.applicationName,
      },
    },
    extensions: options.withMigrator ? [Migrator] : [],
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      silent: true,
    },
  });
}

/**
 * Initialises the ORM, waiting for PostgreSQL with bounded retries so a
 * process started slightly before the database degrades gracefully instead
 * of crash-looping.
 */
export async function initOrm(config: AppConfig, logger: Logger, options: OrmOptions): Promise<MikroORM> {
  const attempts = config.database.startupRetryAttempts;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const orm = await MikroORM.init(mikroOrmOptions(config.database, options));
      if (await orm.isConnected()) {
        return orm;
      }
      await orm.close(true);
      throw new Error('PostgreSQL connection check failed');
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }
      logger.warn('PostgreSQL not reachable yet; retrying', {
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(Math.min(500 * attempt, 5000));
    }
  }
}
