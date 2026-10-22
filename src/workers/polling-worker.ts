import type { Logger } from '../application/ports/runtime.ports';
import { describeError } from '../infrastructure/logging/logger';
import { sleep } from '../shared/sleep';

export interface PollingWorkerOptions {
  name: string;
  /** Pause when a tick found nothing to do. */
  idleDelayMs: number;
  /** Pause after an unexpected error (e.g. database down). */
  errorDelayMs: number;
  /** Periodic side task (backlog gauges). */
  maintenanceIntervalMs: number;
  shutdownTimeoutMs: number;
}

/**
 * Minimal polling loop with graceful stop: `stop()` interrupts the idle
 * sleep, lets the current tick finish (bounded by shutdownTimeoutMs) and
 * never starts a new one. Ticks that found work run back-to-back.
 */
export abstract class PollingWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake = new AbortController();
  private maintenance: ReturnType<typeof setInterval> | undefined;

  protected constructor(
    protected readonly options: PollingWorkerOptions,
    protected readonly logger: Logger,
  ) {}

  /** Returns true when it did work (the loop continues without pausing). */
  protected abstract tick(): Promise<boolean>;

  protected abstract maintain(): Promise<void>;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.wake = new AbortController();
    this.loop = this.run();
    this.maintenance = setInterval(() => {
      this.maintain().catch((error: unknown) =>
        this.logger.warn(`${this.options.name} maintenance failed`, describeError(error)),
      );
    }, this.options.maintenanceIntervalMs);
    this.maintenance.unref?.();
    this.logger.info('Worker started', { worker: this.options.name });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.maintenance);
    this.wake.abort();
    await Promise.race([this.loop, sleep(this.options.shutdownTimeoutMs)]);
    this.logger.info('Worker stopped', { worker: this.options.name });
  }

  isRunning(): boolean {
    return this.running;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let didWork = false;
      try {
        didWork = await this.tick();
      } catch (error) {
        this.logger.error(`${this.options.name} tick failed`, describeError(error));
        await sleep(this.options.errorDelayMs, this.wake.signal);
        continue;
      }
      if (!didWork) {
        await sleep(this.options.idleDelayMs, this.wake.signal);
      }
    }
  }
}
