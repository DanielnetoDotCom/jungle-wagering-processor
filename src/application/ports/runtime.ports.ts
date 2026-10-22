/** Time source. Injected so retry schedules, TTLs and leases are testable without real waits. */
export interface Clock {
  now(): Date;
}

/** Time-ordered unique ids (UUIDv7) for aggregates, ledger entries and events. */
export interface IdGenerator {
  next(): string;
}

export type LogFields = Record<string, unknown>;

/** Structured logger port. Implementations add correlation context automatically. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * Deterministic failure points used by tests to kill or pause a real process
 * at the exact step under test. A no-op in normal operation.
 */
export type FaultPoint =
  | 'wager.before-flush'
  | 'wager.before-commit'
  | 'reference.before-commit'
  | 'consumer.after-commit-before-ack'
  | 'outbox.after-claim'
  | 'outbox.after-publish-before-confirm';

export interface FaultInjector {
  checkpoint(point: FaultPoint): Promise<void>;
}

export const NO_FAULTS: FaultInjector = {
  checkpoint: () => Promise.resolve(),
};
