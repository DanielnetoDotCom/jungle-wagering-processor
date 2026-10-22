import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Logger as Pino } from 'pino';
import type { EventPublisher } from '../application/ports/event-publisher.port';
import type { UnitOfWork } from '../application/ports/persistence.ports';
import type { Clock, FaultInjector, IdGenerator } from '../application/ports/runtime.ports';
import { WalletQueries } from '../application/queries/wallet-queries';
import { SettlementRecorder } from '../application/services/settlement-recorder';
import { TransactionRetryExecutor } from '../application/services/transaction-retry';
import { CreateWalletUseCase } from '../application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../application/use-cases/process-wager-transaction.use-case';
import { PublishOutboxBatchUseCase } from '../application/use-cases/publish-outbox-batch.use-case';
import { ReconcileWalletUseCase } from '../application/use-cases/reconcile-wallet.use-case';
import { ResolvePendingReferenceUseCase } from '../application/use-cases/resolve-pending-reference.use-case';
import { ReferenceRetryPolicy } from '../domain/wagering/reference-retry-policy';
import { WagerSettlementService } from '../domain/wagering/wager-settlement.service';
import type { AppConfig } from '../infrastructure/configuration/config';
import { HealthService } from '../infrastructure/health/health.service';
import { createRootLogger, PinoLogger } from '../infrastructure/logging/logger';
import { createSqsClient, QueueUrlResolver } from '../infrastructure/messaging/sqs/sqs-client';
import { SqsEventPublisher } from '../infrastructure/messaging/sqs/sqs-event-publisher';
import { PrometheusMetrics } from '../infrastructure/metrics/prometheus-metrics';
import { initOrm } from '../infrastructure/persistence/mikroorm/orm';
import { MikroOrmUnitOfWork } from '../infrastructure/persistence/mikroorm/unit-of-work';
import { EnvFaultInjector, SystemClock, UuidV7Generator } from '../infrastructure/runtime/runtime-adapters';
import { ExponentialBackoff } from '../shared/backoff';

/** Test seams: deterministic time, ids, randomness, fault points and broker. */
export interface CoreOverrides {
  clock?: Clock;
  ids?: IdGenerator;
  faults?: FaultInjector;
  random?: () => number;
  publisher?: EventPublisher;
  withMigrator?: boolean;
}

/** Everything a process needs, wired once. Framework-agnostic: Nest modules only expose it. */
export interface Core {
  config: AppConfig;
  rootLogger: Pino;
  logger: PinoLogger;
  metrics: PrometheusMetrics;
  orm: MikroORM;
  uow: UnitOfWork;
  sqs: SQSClient;
  queues: QueueUrlResolver;
  clock: Clock;
  ids: IdGenerator;
  health: HealthService;
  createWallet: CreateWalletUseCase;
  processWager: ProcessWagerTransactionUseCase;
  resolvePendingReference: ResolvePendingReferenceUseCase;
  reconcileWallet: ReconcileWalletUseCase;
  publishOutbox: PublishOutboxBatchUseCase;
  queries: WalletQueries;
  close(): Promise<void>;
}

export async function createCore(config: AppConfig, overrides: CoreOverrides = {}): Promise<Core> {
  const rootLogger = createRootLogger({
    level: config.logLevel,
    serviceName: config.serviceName,
    instanceId: config.instanceId,
  });
  const logger = new PinoLogger(rootLogger);
  const metrics = new PrometheusMetrics({ service: config.serviceName, instance: config.instanceId });
  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new UuidV7Generator();
  const faults =
    overrides.faults ??
    new EnvFaultInjector(config.faultInjection.enabled, config.faultInjection.spec, logger);

  const orm = await initOrm(config, logger, {
    applicationName: `${config.serviceName}:${config.instanceId}`.slice(0, 63),
    withMigrator: overrides.withMigrator ?? false,
  });
  const uow = new MikroOrmUnitOfWork(orm);
  const sqs = createSqsClient(config);
  const queues = new QueueUrlResolver(sqs);

  const retry = new TransactionRetryExecutor(config.transactionRetry, metrics, logger, overrides.random);
  const settlement = new WagerSettlementService(
    ReferenceRetryPolicy.create({
      initialDelayMs: config.reference.initialDelayMs,
      maxDelayMs: config.reference.maxDelayMs,
      multiplier: config.reference.multiplier,
      maxAttempts: config.reference.maxAttempts,
      ttlMs: config.reference.ttlMs,
    }),
  );
  const recorder = new SettlementRecorder(settlement, ids, metrics);
  const publisher = overrides.publisher ?? new SqsEventPublisher(sqs, queues, config.sqs.eventsQueue);

  return {
    config,
    rootLogger,
    logger,
    metrics,
    orm,
    uow,
    sqs,
    queues,
    clock,
    ids,
    health: new HealthService(orm, sqs, queues, config.sqs.transactionsQueue, config.healthCheckTimeoutMs),
    createWallet: new CreateWalletUseCase(uow, clock, ids, metrics, logger, config.acceptedCurrencies),
    processWager: new ProcessWagerTransactionUseCase(
      uow,
      recorder,
      retry,
      clock,
      ids,
      metrics,
      logger,
      faults,
    ),
    resolvePendingReference: new ResolvePendingReferenceUseCase(
      uow,
      recorder,
      retry,
      clock,
      metrics,
      logger,
      faults,
    ),
    reconcileWallet: new ReconcileWalletUseCase(uow, clock, metrics, logger),
    publishOutbox: new PublishOutboxBatchUseCase(uow, publisher, clock, metrics, logger, faults, {
      batchSize: config.outbox.batchSize,
      leaseMs: config.outbox.leaseMs,
      retry: new ExponentialBackoff(
        {
          baseDelayMs: config.outbox.retryBaseMs,
          maxDelayMs: config.outbox.retryMaxMs,
          jitterRatio: 0.3,
          maxAttempts: config.outbox.maxAttempts,
        },
        overrides.random,
      ),
    }),
    queries: new WalletQueries(uow),
    async close() {
      sqs.destroy();
      await orm.close(true);
    },
  };
}
