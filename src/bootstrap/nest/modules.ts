import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { WalletQueries } from '../../application/queries/wallet-queries';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet.use-case';
import { HealthService } from '../../infrastructure/health/health.service';
import { PrometheusMetrics } from '../../infrastructure/metrics/prometheus-metrics';
import {
  NoopProviderIdentityResolver,
  PROVIDER_IDENTITY_RESOLVER,
  ProviderAuthGuard,
} from '../../interfaces/http/auth/provider-identity';
import { INSTANCE_INFO, OperationsController } from '../../interfaces/http/controllers/operations.controller';
import { WageringController } from '../../interfaces/http/controllers/wagering.controller';
import { WalletsController } from '../../interfaces/http/controllers/wallets.controller';
import type { Core } from '../core';

export const CORE = Symbol('CORE');
export const BACKGROUND_WORKER = Symbol('BACKGROUND_WORKER');

/** Anything with a start/stop lifecycle: SQS consumer, outbox publisher, reference worker. */
export interface BackgroundWorker {
  start(): void;
  stop(): Promise<void>;
}

/** Closes the ORM and SQS client after the HTTP server stopped. */
@Injectable()
class CoreLifecycle implements OnApplicationShutdown {
  constructor(@Inject(CORE) private readonly core: Core) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.core.logger.info('Shutting down', { signal });
    await this.core.close();
  }
}

/** Starts the worker once the app is up; stops it (graceful) before the app closes. */
@Injectable()
class WorkerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(BACKGROUND_WORKER) private readonly worker: BackgroundWorker) {}

  onApplicationBootstrap(): void {
    this.worker.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
}

/** Exposes the framework-agnostic Core to Nest DI. */
@Module({})
export class CoreModule {
  static register(core: Core): DynamicModule {
    const providers = [
      { provide: CORE, useValue: core },
      { provide: CreateWalletUseCase, useValue: core.createWallet },
      { provide: ProcessWagerTransactionUseCase, useValue: core.processWager },
      { provide: ReconcileWalletUseCase, useValue: core.reconcileWallet },
      { provide: WalletQueries, useValue: core.queries },
      { provide: HealthService, useValue: core.health },
      { provide: PrometheusMetrics, useValue: core.metrics },
      {
        provide: INSTANCE_INFO,
        useValue: {
          serviceName: core.config.serviceName,
          instanceId: core.config.instanceId,
          startedAt: new Date(),
        },
      },
    ];
    return {
      module: CoreModule,
      global: true,
      providers: [...providers, CoreLifecycle],
      exports: providers.map((provider) => provider.provide),
    };
  }
}

/** HTTP API process: REST endpoints + health + metrics. No background workers here. */
@Module({})
export class ApiModule {
  static register(core: Core): DynamicModule {
    return {
      module: ApiModule,
      imports: [CoreModule.register(core)],
      controllers: [WalletsController, WageringController, OperationsController],
      providers: [
        ProviderAuthGuard,
        { provide: PROVIDER_IDENTITY_RESOLVER, useValue: new NoopProviderIdentityResolver() },
      ],
    };
  }
}

/** Worker processes: one background worker + health/metrics endpoints only. */
@Module({})
export class WorkerModule {
  static register(core: Core, worker: BackgroundWorker): DynamicModule {
    return {
      module: WorkerModule,
      imports: [CoreModule.register(core)],
      controllers: [OperationsController],
      providers: [{ provide: BACKGROUND_WORKER, useValue: worker }, WorkerLifecycle],
    };
  }
}
