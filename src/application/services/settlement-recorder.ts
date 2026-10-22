import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import {
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type {
  SettlementOutcome,
  WagerSettlementService,
} from '../../domain/wagering/wager-settlement.service';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-types';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WageringMetrics } from '../ports/metrics.port';
import type { TransactionalScope } from '../ports/persistence.ports';
import type { IdGenerator } from '../ports/runtime.ports';

export interface SettlementTrace {
  now: Date;
  correlationId: string;
  causationId?: string | undefined;
}

/**
 * Shared by the HTTP/SQS use case and the PendingReferenceWorker: resolves
 * the reference, runs the domain settlement and tracks every resulting write
 * (transaction, wallet, ledger line, outbox events) in the SAME scope, so they
 * are committed by the same PostgreSQL COMMIT or not at all.
 *
 * Preconditions: the wallet row is locked by the caller's transaction.
 */
export class SettlementRecorder {
  constructor(
    private readonly settlement: WagerSettlementService,
    private readonly ids: IdGenerator,
    private readonly metrics: WageringMetrics,
  ) {}

  async settle(
    scope: TransactionalScope,
    transaction: WagerTransaction,
    wallet: Wallet,
    trace: SettlementTrace,
  ): Promise<SettlementOutcome> {
    const { reference, referenceAlreadyReversed } = await this.resolveReference(scope, transaction);
    const outcome = this.settlement.settle(transaction, wallet, {
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      now: trace.now,
    });
    await this.record(scope, transaction, wallet, outcome, trace);
    return outcome;
  }

  /** Worker path for unexpected errors: counts the attempt and eventually ends as FAILED. */
  async recordResolutionFailure(
    scope: TransactionalScope,
    transaction: WagerTransaction,
    wallet: Wallet,
    trace: SettlementTrace,
  ): Promise<SettlementOutcome> {
    const outcome = this.settlement.recordResolutionFailure(transaction, wallet, trace.now);
    await this.record(scope, transaction, wallet, outcome, trace);
    return outcome;
  }

  private async resolveReference(
    scope: TransactionalScope,
    transaction: WagerTransaction,
  ): Promise<{ reference: WagerTransaction | undefined; referenceAlreadyReversed: boolean }> {
    if (transaction.referenceExternalTransactionId === undefined) {
      return { reference: undefined, referenceAlreadyReversed: false };
    }
    const reference = await scope.transactions.findByExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId,
    );
    const referenceAlreadyReversed =
      reference !== undefined &&
      transaction.isReversal() &&
      reference.status === WagerTransactionStatus.Processed &&
      (await scope.transactions.hasProcessedReversal(reference.id));
    return { reference, referenceAlreadyReversed };
  }

  private async record(
    scope: TransactionalScope,
    transaction: WagerTransaction,
    wallet: Wallet,
    outcome: SettlementOutcome,
    trace: SettlementTrace,
  ): Promise<void> {
    scope.transactions.save(transaction);
    const events: IntegrationEvent<unknown>[] = [];

    switch (outcome.type) {
      case 'PROCESSED':
        if (outcome.ledgerEntry) {
          scope.wallets.save(wallet);
          scope.ledger.append(outcome.ledgerEntry);
        }
        events.push(WagerTransactionProcessed.from(transaction, this.eventContext(trace)));
        if (outcome.ledgerEntry) {
          events.push(WalletBalanceChanged.from(wallet, outcome.ledgerEntry, this.eventContext(trace)));
        }
        break;
      case 'REJECTED':
        events.push(WagerTransactionRejected.from(transaction, this.eventContext(trace)));
        break;
      case 'FAILED':
        events.push(WagerTransactionFailed.from(transaction, this.eventContext(trace)));
        break;
      case 'PENDING_REFERENCE':
        events.push(WagerTransactionPendingReference.from(transaction, this.eventContext(trace)));
        break;
      case 'REFERENCE_RETRY_SCHEDULED':
        break;
    }

    for (const event of events) {
      scope.outbox.add(
        OutboxMessage.enqueue(event, event instanceof WalletBalanceChanged ? 'Wallet' : 'WagerTransaction'),
      );
    }

    if (transaction.isTerminal()) {
      // Dependents waiting on this transaction can now be decided: make them due immediately.
      await scope.transactions.wakeDependents({
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        at: trace.now,
      });
    }
    if (outcome.type !== 'REFERENCE_RETRY_SCHEDULED') {
      this.metrics.transactionRecorded(transaction.kind, transaction.status, transaction.channel);
    }
  }

  private eventContext(trace: SettlementTrace): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: trace.correlationId,
      causationId: trace.causationId,
      occurredAt: trace.now,
    };
  }
}
