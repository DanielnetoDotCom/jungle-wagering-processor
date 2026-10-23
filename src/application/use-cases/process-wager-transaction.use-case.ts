import { InboxMessage, InboxOutcome } from '../../domain/messaging/inbox-message';
import { Money } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { SubmitWagerTransactionCommand } from '../commands/wager-commands';
import type { WageringMetrics } from '../ports/metrics.port';
import type { TransactionalScope, UnitOfWork } from '../ports/persistence.ports';
import type { Clock, FaultInjector, IdGenerator, Logger } from '../ports/runtime.ports';
import { wagerPayloadHash } from '../services/payload-hash';
import type { SettlementRecorder } from '../services/settlement-recorder';
import type { TransactionRetryExecutor } from '../services/transaction-retry';
import { toTransactionView, type WagerTransactionView } from '../views';

export type IdempotencyConflictCode = 'IDEMPOTENCY_KEY_CONFLICT' | 'DUPLICATE_EXTERNAL_TRANSACTION';

export type WagerSubmissionResult =
  /** First time this operation is seen: a transaction was recorded (with whatever status it reached). */
  | { type: 'RECORDED'; transaction: WagerTransactionView }
  /** Same idempotency key and payload: the ORIGINAL result is returned, nothing is applied again. */
  | { type: 'REPLAY'; transaction: WagerTransactionView }
  | { type: 'CONFLICT'; code: IdempotencyConflictCode; existingTransactionId: string }
  | { type: 'WALLET_NOT_FOUND' }
  /** SQS only: this message id was already processed by this consumer. */
  | {
      type: 'DUPLICATE_MESSAGE';
      outcome: InboxOutcome | undefined;
      transaction: WagerTransactionView | undefined;
    }
  /** SQS only: the message id was already used for a different payload. */
  | { type: 'MESSAGE_ID_CONFLICT' };

/**
 * The single financial write path for provider operations (HTTP and SQS).
 *
 * One PostgreSQL transaction (READ COMMITTED):
 *   1. lock the wallet row (FOR UPDATE)            -> serializes the wallet
 *   2. inbox check (SQS)                           -> message deduplication
 *   3. idempotency check by key / externalId       -> replay or conflict
 *   4. domain settlement                           -> status, balance, ledger
 *   5. inbox + transaction + wallet + ledger + outbox written, then COMMIT
 * Nothing is published to SQS here: the outbox worker does it after commit.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly recorder: SettlementRecorder,
    private readonly retry: TransactionRetryExecutor,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
    private readonly faults: FaultInjector,
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<WagerSubmissionResult> {
    const startedAt = performance.now();
    // Validates the amount (scale, sign, currency) before anything touches the database.
    const money = Money.from(command.payload.money);
    const payloadHash = wagerPayloadHash(command.payload);

    const result = await this.retry.run('process-wager', () =>
      this.uow.run((scope) => this.process(scope, command, money, payloadHash)),
    );

    this.observe(command, result, (performance.now() - startedAt) / 1000);
    return result;
  }

  private async process(
    scope: TransactionalScope,
    command: SubmitWagerTransactionCommand,
    money: Money,
    payloadHash: string,
  ): Promise<WagerSubmissionResult> {
    const lock = await scope.wallets.lockById(command.payload.walletId);
    this.metrics.walletLockAcquired(lock.waitSeconds, lock.contended);
    // Decision time is taken AFTER the lock: timestamps then follow wallet version order.
    const now = this.clock.now();

    let inbox: InboxMessage | undefined;
    if (command.inbox) {
      const existing = await scope.inbox.find(command.inbox.consumerName, command.inbox.messageId);
      if (existing?.isProcessed()) {
        if (!existing.matchesPayload(payloadHash)) {
          return { type: 'MESSAGE_ID_CONFLICT' };
        }
        const previous = existing.transactionId
          ? await scope.transactions.findById(existing.transactionId)
          : undefined;
        return {
          type: 'DUPLICATE_MESSAGE',
          outcome: existing.outcome,
          transaction: previous ? toTransactionView(previous) : undefined,
        };
      }
      inbox =
        existing ??
        InboxMessage.receive({
          messageId: command.inbox.messageId,
          consumerName: command.inbox.consumerName,
          payloadHash,
          receiveCount: command.inbox.receiveCount,
          receivedAt: now,
        });
      // A row that was never PROCESSED (dead-lettered before) adopts the payload processed now.
      inbox.registerRedelivery(command.inbox.receiveCount, payloadHash);
    }

    const result = await this.decide(scope, command, lock.wallet, money, payloadHash, now);

    if (inbox) {
      inbox.markProcessed(now, inboxResultOf(result));
      scope.inbox.save(inbox);
    }
    await this.faults.checkpoint('wager.before-flush');
    await scope.flush();
    await this.faults.checkpoint('wager.before-commit');
    return result;
  }

  private async decide(
    scope: TransactionalScope,
    command: SubmitWagerTransactionCommand,
    wallet: Wallet | undefined,
    money: Money,
    payloadHash: string,
    now: Date,
  ): Promise<WagerSubmissionResult> {
    const { payload } = command;

    const byKey = await scope.transactions.findByIdempotencyKey(payload.providerId, command.idempotencyKey);
    if (byKey) {
      return idempotentOutcome(byKey, payloadHash);
    }
    // Same provider operation submitted under another idempotency key: never a second effect.
    const byExternalId = await scope.transactions.findByExternalId(
      payload.providerId,
      payload.externalTransactionId,
    );
    if (byExternalId) {
      return {
        type: 'CONFLICT',
        code: 'DUPLICATE_EXTERNAL_TRANSACTION',
        existingTransactionId: byExternalId.id,
      };
    }
    if (!wallet) {
      return { type: 'WALLET_NOT_FOUND' };
    }

    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      channel: command.channel,
      walletId: payload.walletId,
      playerId: payload.playerId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money,
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
      createdAt: now,
    });
    await this.recorder.settle(scope, transaction, wallet, {
      now,
      correlationId: command.correlationId,
      causationId: command.causationId,
    });
    return { type: 'RECORDED', transaction: toTransactionView(transaction) };
  }

  private observe(
    command: SubmitWagerTransactionCommand,
    result: WagerSubmissionResult,
    seconds: number,
  ): void {
    const fields = {
      providerId: command.payload.providerId,
      walletId: command.payload.walletId,
      externalTransactionId: command.payload.externalTransactionId,
      kind: command.payload.kind,
      channel: command.channel,
      result: result.type,
    };
    switch (result.type) {
      case 'RECORDED':
        this.logger.info('Wager transaction recorded', {
          ...fields,
          transactionId: result.transaction.transactionId,
          status: result.transaction.status,
          failureCode: result.transaction.failureCode,
        });
        break;
      case 'REPLAY':
        this.metrics.idempotentReplay(command.channel);
        this.logger.info('Idempotent replay', { ...fields, transactionId: result.transaction.transactionId });
        break;
      case 'CONFLICT':
        this.metrics.idempotencyConflict(result.code, command.channel);
        this.logger.warn('Idempotency conflict', {
          ...fields,
          code: result.code,
          existingTransactionId: result.existingTransactionId,
        });
        break;
      case 'DUPLICATE_MESSAGE':
        this.metrics.duplicateMessage(command.inbox?.consumerName ?? 'unknown');
        this.logger.info('Duplicate message ignored (inbox)', fields);
        break;
      case 'MESSAGE_ID_CONFLICT':
      case 'WALLET_NOT_FOUND':
        this.logger.warn('Wager transaction not applied', fields);
        break;
    }
    this.metrics.processingDuration('process-wager', result.type, seconds);
  }
}

/**
 * A transaction already stored under the same idempotency key: the identical
 * payload gets the ORIGINAL result back (including the balance observed then),
 * any other payload is a conflict. Never a second effect, never a replay of a
 * different operation.
 */
export function idempotentOutcome(existing: WagerTransaction, payloadHash: string): WagerSubmissionResult {
  return existing.matchesPayload(payloadHash)
    ? { type: 'REPLAY', transaction: toTransactionView(existing) }
    : { type: 'CONFLICT', code: 'IDEMPOTENCY_KEY_CONFLICT', existingTransactionId: existing.id };
}

function inboxResultOf(result: WagerSubmissionResult): {
  outcome: InboxOutcome;
  transactionId?: string | undefined;
  resultCode?: string | undefined;
} {
  switch (result.type) {
    case 'RECORDED':
      return {
        outcome: InboxOutcome.Applied,
        transactionId: result.transaction.transactionId,
        resultCode: result.transaction.failureCode ?? result.transaction.status,
      };
    case 'REPLAY':
      return { outcome: InboxOutcome.Replayed, transactionId: result.transaction.transactionId };
    case 'CONFLICT':
      return {
        outcome: InboxOutcome.Conflict,
        transactionId: result.existingTransactionId,
        resultCode: result.code,
      };
    case 'WALLET_NOT_FOUND':
      return { outcome: InboxOutcome.WalletNotFound, resultCode: 'WALLET_NOT_FOUND' };
    case 'DUPLICATE_MESSAGE':
    case 'MESSAGE_ID_CONFLICT':
      throw new Error(`Unreachable: ${result.type} never records an inbox row`);
  }
}
