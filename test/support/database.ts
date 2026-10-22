import { randomBytes } from 'node:crypto';
import { Client, Pool, type QueryResultRow } from 'pg';
import { PinoLogger, createRootLogger } from '../../src/infrastructure/logging/logger';
import {
  executeMigrations,
  provisionApplicationLogin,
} from '../../src/infrastructure/persistence/mikroorm/migrations-runner';
import { initOrm } from '../../src/infrastructure/persistence/mikroorm/orm';
import { testConfig, testInfra } from './environment';

export const silentLogger = new PinoLogger(
  createRootLogger({ level: 'silent', serviceName: 'test', instanceId: 'test' }),
);

/**
 * A throw-away PostgreSQL database per test file: created on the real server,
 * migrated with the real migrations (as schema owner), with the
 * least-privilege runtime login provisioned exactly like production.
 */
export class TestDatabase {
  private constructor(
    readonly name: string,
    /** Superuser/owner pool on the test database, for setup and white-box assertions. */
    readonly admin: Pool,
  ) {}

  static async create(label: string): Promise<TestDatabase> {
    const name = `wagering_test_${label.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${randomBytes(4).toString('hex')}`;
    const bootstrap = new Client({
      host: testInfra.dbHost,
      port: testInfra.dbPort,
      user: testInfra.adminUser,
      password: testInfra.adminPassword,
      database: testInfra.adminDatabase,
    });
    await bootstrap.connect();
    try {
      await bootstrap.query(`CREATE DATABASE ${name}`);
    } finally {
      await bootstrap.end();
    }

    await TestDatabase.migrate(name, 'up');
    const admin = new Pool({
      host: testInfra.dbHost,
      port: testInfra.dbPort,
      user: testInfra.adminUser,
      password: testInfra.adminPassword,
      database: name,
      max: 10,
    });
    return new TestDatabase(name, admin);
  }

  /** Runs migrations as the owner; `up` also provisions the runtime login. */
  static async migrate(dbName: string, command: 'up' | 'down', to?: string | 0): Promise<string[]> {
    const config = testConfig({ dbName, user: testInfra.adminUser, password: testInfra.adminPassword });
    const orm = await initOrm(config, silentLogger, {
      applicationName: 'test-migrations',
      withMigrator: true,
    });
    try {
      const report = await executeMigrations(orm, command, to === undefined ? {} : { to });
      if (command === 'up') {
        await provisionApplicationLogin(orm, testInfra.appUser, testInfra.appPassword);
      }
      return report.changed;
    } finally {
      await orm.close(true);
    }
  }

  async query<Row extends QueryResultRow = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<Row[]> {
    const result = await this.admin.query<Row>(text, params);
    return result.rows;
  }

  async one<Row extends QueryResultRow = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<Row> {
    const rows = await this.query<Row>(text, params);
    if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}: ${text}`);
    return rows[0] as Row;
  }

  /** Runs a statement from the administrative database (e.g. ALTER DATABASE on this one). */
  async control(statement: string): Promise<void> {
    const client = new Client({
      host: testInfra.dbHost,
      port: testInfra.dbPort,
      user: testInfra.adminUser,
      password: testInfra.adminPassword,
      database: testInfra.adminDatabase,
    });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  }

  /** A connection with the runtime (least-privilege) login, to prove grants. */
  async appClient(): Promise<Client> {
    const client = new Client({
      host: testInfra.dbHost,
      port: testInfra.dbPort,
      user: testInfra.appUser,
      password: testInfra.appPassword,
      database: this.name,
    });
    await client.connect();
    return client;
  }

  async drop(): Promise<void> {
    await this.admin.end();
    const bootstrap = new Client({
      host: testInfra.dbHost,
      port: testInfra.dbPort,
      user: testInfra.adminUser,
      password: testInfra.adminPassword,
      database: testInfra.adminDatabase,
    });
    await bootstrap.connect();
    try {
      await bootstrap.query(`DROP DATABASE IF EXISTS ${this.name} WITH (FORCE)`);
    } finally {
      await bootstrap.end();
    }
  }
}
