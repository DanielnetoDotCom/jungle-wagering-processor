import { loadConfig, type AppConfig } from '../../src/infrastructure/configuration/config';

/**
 * Integration tests talk to the REAL PostgreSQL and LocalStack of the compose
 * stack (run them through `docker compose --profile tools run --rm toolbox`).
 */
export const testInfra = {
  dbHost: process.env.TEST_DB_HOST ?? 'localhost',
  dbPort: Number(process.env.TEST_DB_PORT ?? '5432'),
  adminUser: process.env.TEST_DB_ADMIN_USER ?? 'wagering_owner',
  adminPassword: process.env.TEST_DB_ADMIN_PASSWORD ?? 'local-dev-owner-password',
  adminDatabase: process.env.TEST_DB_ADMIN_DATABASE ?? 'wagering',
  appUser: 'wagering_test_service',
  appPassword: 'wagering-test-service-password',
  awsEndpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  awsRegion: process.env.AWS_REGION ?? 'us-east-1',
  logLevel: process.env.LOG_LEVEL ?? 'silent',
};

export interface TestQueueNames {
  transactionsQueue: string;
  transactionsDlq: string;
  eventsQueue: string;
}

/** Environment variables for a process (in-process core or spawned child) bound to one test database. */
export function serviceEnvironment(params: {
  dbName: string;
  user?: string;
  password?: string;
  queues?: TestQueueNames;
  extra?: Record<string, string>;
}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    TZ: 'UTC',
    LOG_LEVEL: testInfra.logLevel,
    DB_HOST: testInfra.dbHost,
    DB_PORT: String(testInfra.dbPort),
    DB_NAME: params.dbName,
    DB_USER: params.user ?? testInfra.appUser,
    DB_PASSWORD: params.password ?? testInfra.appPassword,
    DB_POOL_MAX: '20',
    DB_LOCK_TIMEOUT_MS: '5000',
    DB_STARTUP_RETRY_ATTEMPTS: '5',
    AWS_REGION: testInfra.awsRegion,
    AWS_ENDPOINT_URL: testInfra.awsEndpoint,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    SQS_TRANSACTIONS_QUEUE: params.queues?.transactionsQueue ?? 'test-unused-transactions.fifo',
    SQS_TRANSACTIONS_DLQ: params.queues?.transactionsDlq ?? 'test-unused-transactions-dlq.fifo',
    SQS_EVENTS_QUEUE: params.queues?.eventsQueue ?? 'test-unused-events.fifo',
    SQS_WAIT_TIME_SECONDS: '1',
    ACCEPTED_CURRENCIES: 'BRL,USD',
    ...params.extra,
  };
}

export function testConfig(params: Parameters<typeof serviceEnvironment>[0]): AppConfig {
  return loadConfig(serviceEnvironment(params));
}
