import { hostname } from 'node:os';
import { z } from 'zod';
import { isSupportedCurrency } from '../../domain/money/currency';

const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const flag = (fallback: boolean) => z.stringbool().default(fallback);

/**
 * Every setting comes from the environment and is validated at startup: a
 * process with an invalid configuration refuses to start instead of failing
 * later in the middle of a financial operation. Secrets have no defaults.
 */
const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1).default('wagering'),
  INSTANCE_ID: z.string().min(1).default(hostname()),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  HTTP_PORT: int(3000, 1, 65535),
  METRICS_PORT: int(9100, 1, 65535),
  HTTP_BODY_LIMIT: z.string().default('64kb'),

  DB_HOST: z.string().min(1),
  DB_PORT: int(5432, 1, 65535),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_POOL_MIN: int(0),
  DB_POOL_MAX: int(10, 1, 200),
  DB_CONNECT_TIMEOUT_MS: int(5000, 100),
  DB_ACQUIRE_TIMEOUT_MS: int(10000, 100),
  DB_STATEMENT_TIMEOUT_MS: int(15000, 100),
  DB_LOCK_TIMEOUT_MS: int(5000, 10),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: int(30000, 100),
  DB_STARTUP_RETRY_ATTEMPTS: int(30, 1),
  DB_DEBUG: flag(false),

  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
  SQS_TRANSACTIONS_QUEUE: z.string().endsWith('.fifo').default('wager-transactions.fifo'),
  SQS_TRANSACTIONS_DLQ: z.string().endsWith('.fifo').default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().endsWith('.fifo').default('wager-events.fifo'),
  SQS_WAIT_TIME_SECONDS: int(20, 0, 20),
  SQS_VISIBILITY_TIMEOUT_SECONDS: int(30, 1, 43200),
  SQS_MAX_MESSAGES: int(10, 1, 10),
  /** Queue redrive: a safety net only (e.g. a message that crashes the process). See CONSUMER_MAX_ATTEMPTS. */
  SQS_MAX_RECEIVE_COUNT: int(100, 1, 1000),
  SQS_RETRY_BASE_MS: int(1000, 1),
  SQS_RETRY_MAX_MS: int(60000, 1),
  SQS_REQUEST_TIMEOUT_MS: int(25000, 1000),

  CONSUMER_NAME: z.string().min(1).default('wager-transactions-consumer'),
  CONSUMER_SHUTDOWN_TIMEOUT_MS: int(20000, 0),
  /** Real (persisted) processing attempts of one message before the consumer dead-letters it. */
  CONSUMER_MAX_ATTEMPTS: int(5, 1, 100),

  OUTBOX_BATCH_SIZE: int(50, 1, 500),
  OUTBOX_POLL_INTERVAL_MS: int(250, 10),
  OUTBOX_LEASE_MS: int(30000, 100),
  OUTBOX_MAX_ATTEMPTS: int(15, 1),
  OUTBOX_RETRY_BASE_MS: int(1000, 1),
  OUTBOX_RETRY_MAX_MS: int(300000, 1),

  REFERENCE_RETRY_INITIAL_MS: int(2000, 1),
  REFERENCE_RETRY_MAX_MS: int(300000, 1),
  REFERENCE_RETRY_MULTIPLIER: z.coerce.number().min(1).default(2),
  REFERENCE_MAX_ATTEMPTS: int(20, 1),
  REFERENCE_TTL_MS: int(3600000, 1),
  REFERENCE_BATCH_SIZE: int(20, 1, 500),
  REFERENCE_POLL_INTERVAL_MS: int(1000, 10),
  REFERENCE_LEASE_MS: int(30000, 100),
  REFERENCE_CONCURRENCY: int(4, 1, 64),

  TX_RETRY_MAX_ATTEMPTS: int(4, 1, 20),
  TX_RETRY_BASE_MS: int(20, 1),
  TX_RETRY_MAX_MS: int(500, 1),

  BACKLOG_METRICS_INTERVAL_MS: int(5000, 100),
  HEALTH_CHECK_TIMEOUT_MS: int(2000, 100),
  ACCEPTED_CURRENCIES: z.string().default('BRL'),
  AUTH_MODE: z.enum(['none']).default('none'),

  FAULT_INJECTION_ENABLED: flag(false),
  FAULT_INJECTION: z.string().default(''),
});

export type Environment = z.infer<typeof environmentSchema>;

export interface AppConfig {
  nodeEnv: Environment['NODE_ENV'];
  serviceName: string;
  instanceId: string;
  logLevel: Environment['LOG_LEVEL'];
  http: { port: number; bodyLimit: string };
  metricsPort: number;
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    poolMin: number;
    poolMax: number;
    connectTimeoutMs: number;
    acquireTimeoutMs: number;
    statementTimeoutMs: number;
    lockTimeoutMs: number;
    idleInTransactionTimeoutMs: number;
    startupRetryAttempts: number;
    debug: boolean;
  };
  aws: { region: string; endpoint: string | undefined };
  sqs: {
    transactionsQueue: string;
    transactionsDlq: string;
    eventsQueue: string;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    maxMessages: number;
    maxReceiveCount: number;
    retryBaseMs: number;
    retryMaxMs: number;
    requestTimeoutMs: number;
  };
  consumer: { name: string; shutdownTimeoutMs: number; maxAttempts: number };
  outbox: {
    batchSize: number;
    pollIntervalMs: number;
    leaseMs: number;
    maxAttempts: number;
    retryBaseMs: number;
    retryMaxMs: number;
  };
  reference: {
    initialDelayMs: number;
    maxDelayMs: number;
    multiplier: number;
    maxAttempts: number;
    ttlMs: number;
    batchSize: number;
    pollIntervalMs: number;
    leaseMs: number;
    concurrency: number;
  };
  transactionRetry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  backlogMetricsIntervalMs: number;
  healthCheckTimeoutMs: number;
  acceptedCurrencies: ReadonlySet<string>;
  authMode: Environment['AUTH_MODE'];
  faultInjection: { enabled: boolean; spec: string };
}

export class ConfigurationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigurationError';
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  const e = parsed.data;

  const currencies = e.ACCEPTED_CURRENCIES.split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code.length > 0);
  const invalid = currencies.filter((code) => !isSupportedCurrency(code));
  if (currencies.length === 0 || invalid.length > 0) {
    throw new ConfigurationError([
      `ACCEPTED_CURRENCIES: unsupported currencies ${invalid.join(', ') || '(empty)'}`,
    ]);
  }
  if (e.SQS_RETRY_MAX_MS < e.SQS_RETRY_BASE_MS || e.REFERENCE_RETRY_MAX_MS < e.REFERENCE_RETRY_INITIAL_MS) {
    throw new ConfigurationError(['retry max delays must be >= their base delays']);
  }
  // A FIFO message is received again with every failed attempt of each message
  // ahead of it in the same batch. Below this bound the queue redrive could
  // dead-letter it before it was ever processed.
  if (e.SQS_MAX_RECEIVE_COUNT < e.CONSUMER_MAX_ATTEMPTS * e.SQS_MAX_MESSAGES) {
    throw new ConfigurationError([
      `SQS_MAX_RECEIVE_COUNT must be >= CONSUMER_MAX_ATTEMPTS * SQS_MAX_MESSAGES (${e.CONSUMER_MAX_ATTEMPTS * e.SQS_MAX_MESSAGES})`,
    ]);
  }
  if (e.FAULT_INJECTION_ENABLED && e.NODE_ENV === 'production' && e.FAULT_INJECTION.trim() !== '') {
    throw new ConfigurationError(['FAULT_INJECTION cannot be enabled when NODE_ENV=production']);
  }

  return {
    nodeEnv: e.NODE_ENV,
    serviceName: e.SERVICE_NAME,
    instanceId: e.INSTANCE_ID,
    logLevel: e.LOG_LEVEL,
    http: { port: e.HTTP_PORT, bodyLimit: e.HTTP_BODY_LIMIT },
    metricsPort: e.METRICS_PORT,
    database: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      name: e.DB_NAME,
      user: e.DB_USER,
      password: e.DB_PASSWORD,
      poolMin: e.DB_POOL_MIN,
      poolMax: e.DB_POOL_MAX,
      connectTimeoutMs: e.DB_CONNECT_TIMEOUT_MS,
      acquireTimeoutMs: e.DB_ACQUIRE_TIMEOUT_MS,
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: e.DB_LOCK_TIMEOUT_MS,
      idleInTransactionTimeoutMs: e.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      startupRetryAttempts: e.DB_STARTUP_RETRY_ATTEMPTS,
      debug: e.DB_DEBUG,
    },
    aws: { region: e.AWS_REGION, endpoint: e.AWS_ENDPOINT_URL },
    sqs: {
      transactionsQueue: e.SQS_TRANSACTIONS_QUEUE,
      transactionsDlq: e.SQS_TRANSACTIONS_DLQ,
      eventsQueue: e.SQS_EVENTS_QUEUE,
      waitTimeSeconds: e.SQS_WAIT_TIME_SECONDS,
      visibilityTimeoutSeconds: e.SQS_VISIBILITY_TIMEOUT_SECONDS,
      maxMessages: e.SQS_MAX_MESSAGES,
      maxReceiveCount: e.SQS_MAX_RECEIVE_COUNT,
      retryBaseMs: e.SQS_RETRY_BASE_MS,
      retryMaxMs: e.SQS_RETRY_MAX_MS,
      requestTimeoutMs: e.SQS_REQUEST_TIMEOUT_MS,
    },
    consumer: {
      name: e.CONSUMER_NAME,
      shutdownTimeoutMs: e.CONSUMER_SHUTDOWN_TIMEOUT_MS,
      maxAttempts: e.CONSUMER_MAX_ATTEMPTS,
    },
    outbox: {
      batchSize: e.OUTBOX_BATCH_SIZE,
      pollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS,
      leaseMs: e.OUTBOX_LEASE_MS,
      maxAttempts: e.OUTBOX_MAX_ATTEMPTS,
      retryBaseMs: e.OUTBOX_RETRY_BASE_MS,
      retryMaxMs: e.OUTBOX_RETRY_MAX_MS,
    },
    reference: {
      initialDelayMs: e.REFERENCE_RETRY_INITIAL_MS,
      maxDelayMs: e.REFERENCE_RETRY_MAX_MS,
      multiplier: e.REFERENCE_RETRY_MULTIPLIER,
      maxAttempts: e.REFERENCE_MAX_ATTEMPTS,
      ttlMs: e.REFERENCE_TTL_MS,
      batchSize: e.REFERENCE_BATCH_SIZE,
      pollIntervalMs: e.REFERENCE_POLL_INTERVAL_MS,
      leaseMs: e.REFERENCE_LEASE_MS,
      concurrency: e.REFERENCE_CONCURRENCY,
    },
    transactionRetry: {
      maxAttempts: e.TX_RETRY_MAX_ATTEMPTS,
      baseDelayMs: e.TX_RETRY_BASE_MS,
      maxDelayMs: e.TX_RETRY_MAX_MS,
    },
    backlogMetricsIntervalMs: e.BACKLOG_METRICS_INTERVAL_MS,
    healthCheckTimeoutMs: e.HEALTH_CHECK_TIMEOUT_MS,
    acceptedCurrencies: new Set(currencies),
    authMode: e.AUTH_MODE,
    faultInjection: { enabled: e.FAULT_INJECTION_ENABLED, spec: e.FAULT_INJECTION },
  };
}
