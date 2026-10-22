import { createRootLogger, PinoLogger } from '../infrastructure/logging/logger';
import { initOrm } from '../infrastructure/persistence/mikroorm/orm';
import {
  executeMigrations,
  type MigrationCommand,
  provisionApplicationLogin,
} from '../infrastructure/persistence/mikroorm/migrations-runner';
import { runProcess } from '../bootstrap/process-runner';

/**
 * Usage: migrate.ts up | down [--all] | status
 * Runs with the schema OWNER credentials: DB_MIGRATION_USER/DB_MIGRATION_PASSWORD
 * when set, otherwise DB_USER/DB_PASSWORD. When DB_APP_USER and
 * DB_APP_PASSWORD are set, `up` also provisions the least-privilege runtime
 * login used by the services.
 */
void runProcess('migrations', async (runtimeConfig) => {
  const command = (process.argv[2] ?? 'up') as MigrationCommand;
  if (!['up', 'down', 'status'].includes(command)) {
    throw new Error(`Unknown migration command "${command}" (expected up | down | status)`);
  }
  const owner = process.env.DB_MIGRATION_USER;
  const config = owner
    ? {
        ...runtimeConfig,
        database: {
          ...runtimeConfig.database,
          user: owner,
          password: process.env.DB_MIGRATION_PASSWORD ?? '',
        },
      }
    : runtimeConfig;
  const logger = new PinoLogger(
    createRootLogger({
      level: config.logLevel,
      serviceName: config.serviceName,
      instanceId: config.instanceId,
    }),
  );
  const orm = await initOrm(config, logger, { applicationName: 'migrations', withMigrator: true });
  try {
    const report = await executeMigrations(orm, command, process.argv.includes('--all') ? { to: 0 } : {});
    logger.info(`Migrations ${command} finished`, { ...report });

    const appUser = process.env.DB_APP_USER;
    const appPassword = process.env.DB_APP_PASSWORD;
    if (command === 'up' && appUser && appPassword) {
      await provisionApplicationLogin(orm, appUser, appPassword);
      logger.info('Runtime database login provisioned', { user: appUser, role: 'wagering_app' });
    }
  } finally {
    await orm.close(true);
  }
});
