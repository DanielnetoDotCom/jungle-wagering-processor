import type { MikroORM } from '@mikro-orm/postgresql';
import type { Logger } from '../../../application/ports/runtime.ports';
import type { AppConfig } from '../../configuration/config';
import { initOrm } from './orm';
import { sql } from './sql';

export type MigrationCommand = 'up' | 'down' | 'status';

export interface MigrationReport {
  executed: string[];
  pending: string[];
  changed: string[];
}

/**
 * Runs versioned migrations with the schema OWNER credentials. `down` reverts
 * the last migration (or down to `to`, where `to: 0` reverts everything).
 * Each migration runs in its own transaction (allOrNothing for batches).
 */
export async function runMigrations(
  config: AppConfig,
  logger: Logger,
  command: MigrationCommand,
  options: { to?: string | 0 } = {},
): Promise<MigrationReport> {
  const orm = await initOrm(config, logger, { applicationName: 'migrations', withMigrator: true });
  try {
    return await executeMigrations(orm, command, options);
  } finally {
    await orm.close(true);
  }
}

export async function executeMigrations(
  orm: MikroORM,
  command: MigrationCommand,
  options: { to?: string | 0 } = {},
): Promise<MigrationReport> {
  const migrator = orm.getMigrator();
  let changed: string[] = [];
  if (command === 'up') {
    changed = (await migrator.up()).map((migration) => migration.name);
  } else if (command === 'down') {
    changed = (await migrator.down(options.to === undefined ? undefined : { to: options.to })).map(
      (migration) => migration.name,
    );
  }
  const executed = (await migrator.getExecutedMigrations()).map((row) => row.name);
  const pending = (await migrator.getPendingMigrations()).map((migration) => migration.name);
  return { executed, pending, changed };
}

/**
 * Creates/updates the runtime LOGIN role and makes it a member of the
 * least-privilege group `wagering_app` (created by the migrations). Values
 * are passed as bound parameters and quoted by PostgreSQL's format(%I/%L).
 */
export async function provisionApplicationLogin(
  orm: MikroORM,
  user: string,
  password: string,
): Promise<void> {
  await orm.em.fork().transactional(async (em) => {
    await sql(
      em,
      `SELECT set_config('wagering.app_user', ?, true), set_config('wagering.app_password', ?, true)`,
      [user, password],
    );
    await sql(
      em,
      `DO $$
       DECLARE
         login_name text := current_setting('wagering.app_user');
         login_password text := current_setting('wagering.app_password');
       BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = login_name) THEN
           EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', login_name, login_password);
         ELSE
           EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L', login_name, login_password);
         END IF;
         EXECUTE format('GRANT wagering_app TO %I', login_name);
       END
       $$`,
    );
  });
}
