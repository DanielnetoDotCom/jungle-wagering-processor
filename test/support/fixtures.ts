import { randomUUID } from 'node:crypto';
import type {
  SubmitWagerTransactionCommand,
  WagerTransactionPayload,
} from '../../src/application/commands/wager-commands';
import type { Clock, FaultInjector, FaultPoint } from '../../src/application/ports/runtime.ports';
import { TransactionChannel, WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-types';

export const PROVIDER = 'provider-a';

export function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function payload(params: {
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind | `${WagerTransactionKind}`;
  amount: string;
  externalTransactionId?: string;
  roundId?: string;
  reference?: string;
  currency?: string;
  providerId?: string;
}): WagerTransactionPayload {
  return {
    providerId: params.providerId ?? PROVIDER,
    externalTransactionId: params.externalTransactionId ?? uniqueId('tx'),
    playerId: params.playerId,
    walletId: params.walletId,
    roundId: params.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind: params.kind as WagerTransactionKind,
    money: { amount: params.amount, currency: params.currency ?? 'BRL' },
    ...(params.reference ? { referenceExternalTransactionId: params.reference } : {}),
  };
}

export function httpCommand(
  body: WagerTransactionPayload,
  idempotencyKey?: string,
): SubmitWagerTransactionCommand {
  return {
    idempotencyKey: idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}`,
    payload: body,
    channel: TransactionChannel.Http,
    correlationId: randomUUID(),
  };
}

export function sqsCommand(
  body: WagerTransactionPayload,
  messageId: string,
  idempotencyKey?: string,
  consumerName = 'test-consumer',
): SubmitWagerTransactionCommand {
  return {
    idempotencyKey: idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}`,
    payload: body,
    channel: TransactionChannel.Sqs,
    correlationId: randomUUID(),
    causationId: messageId,
    inbox: { consumerName, messageId, receiveCount: 1 },
  };
}

/** Time under test control: TTLs, backoffs and leases without real waiting. */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date = new Date('2026-10-22T12:00:00.000Z')) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(date: Date): void {
    this.current = date.getTime();
  }
}

/** In-process fault points: throw or pause (latch) at a precise step. */
export class ScriptedFaults implements FaultInjector {
  private readonly handlers = new Map<FaultPoint, () => Promise<void>>();

  on(point: FaultPoint, handler: () => Promise<void>): void {
    this.handlers.set(point, handler);
  }

  clear(): void {
    this.handlers.clear();
  }

  async checkpoint(point: FaultPoint): Promise<void> {
    const handler = this.handlers.get(point);
    if (handler) await handler();
  }
}

export class Latch {
  private release: (() => void) | undefined;
  readonly opened: Promise<void>;
  private reachedResolve: (() => void) | undefined;
  readonly reached: Promise<void>;

  constructor() {
    this.opened = new Promise((resolve) => (this.release = resolve));
    this.reached = new Promise((resolve) => (this.reachedResolve = resolve));
  }

  /** Called by the code under test: signals arrival and waits for `open()`. */
  async wait(): Promise<void> {
    this.reachedResolve?.();
    await this.opened;
  }

  open(): void {
    this.release?.();
  }
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${options.description ?? 'condition'}`);
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 100));
  }
}
