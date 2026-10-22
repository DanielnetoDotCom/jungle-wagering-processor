import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { QueueUrlResolver } from '../messaging/sqs/sqs-client';

export interface DependencyCheck {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: { postgres: DependencyCheck; sqs: DependencyCheck };
}

/**
 * Readiness = PostgreSQL and SQS answer within a short timeout. Liveness is
 * deliberately NOT tied to dependencies: a database outage must make the
 * instance unready (no traffic), not trigger restarts of a healthy process.
 */
export class HealthService {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrlResolver,
    private readonly queueName: string,
    private readonly timeoutMs: number,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      this.check(() => this.pingPostgres()),
      this.check(() => this.pingSqs()),
    ]);
    return {
      status: postgres.status === 'up' && sqs.status === 'up' ? 'ready' : 'not_ready',
      checks: { postgres, sqs },
    };
  }

  /** Database-only probe (used by the SQS consumer to wait out an outage). */
  async isPostgresAvailable(): Promise<boolean> {
    return (await this.check(() => this.pingPostgres())).status === 'up';
  }

  private async pingPostgres(): Promise<void> {
    await this.orm.em.fork().getConnection().execute('SELECT 1');
  }

  private async pingSqs(signal?: AbortSignal): Promise<void> {
    const queueUrl = await this.queues.resolve(this.queueName);
    await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }), {
      abortSignal: signal,
    });
  }

  private async check(probe: (signal: AbortSignal) => Promise<void>): Promise<DependencyCheck> {
    const startedAt = performance.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        probe(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`timed out after ${this.timeoutMs}ms`));
          }, this.timeoutMs);
        }),
      ]);
      return { status: 'up', latencyMs: Math.round(performance.now() - startedAt) };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message.split('\n')[0] : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
