import { LockMode } from '@mikro-orm/core';
import type { SqlEntityManager } from '@mikro-orm/postgresql';
import type {
  PendingReferenceClaim,
  WagerTransactionRepository,
} from '../../../application/ports/persistence.ports';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import { toWagerTransaction, wagerTransactionData } from './mappers';
import { WagerTransactionRecord, WalletRecord } from './records';
import { isUuid, sql } from './sql';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    if (!isUuid(id)) return undefined;
    const record = await this.em.findOne(WagerTransactionRecord, { id });
    return record ? this.toDomain(record) : undefined;
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    if (!isUuid(id)) return undefined;
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? this.toDomain(record) : undefined;
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { providerId, idempotencyKey },
      { refresh: true },
    );
    return record ? this.toDomain(record) : undefined;
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { providerId, externalTransactionId },
      { refresh: true },
    );
    return record ? this.toDomain(record) : undefined;
  }

  private async toDomain(record: WagerTransactionRecord): Promise<WagerTransaction> {
    const wallet = await this.em.findOneOrFail(WalletRecord, { id: record.walletId });
    return toWagerTransaction(record, wallet.currency);
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: 'PROCESSED',
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  save(transaction: WagerTransaction): void {
    const data = wagerTransactionData(transaction);
    const managed = this.em
      .getUnitOfWork()
      .getById<WagerTransactionRecord>(WagerTransactionRecord.name, transaction.id);
    if (managed) {
      this.em.assign(managed, data);
    } else {
      this.em.persist(this.em.create(WagerTransactionRecord, data));
    }
  }

  async wakeDependents(params: {
    providerId: string;
    externalTransactionId: string;
    walletId: string;
    at: Date;
  }): Promise<number> {
    const result = await sql(
      this.em,
      `UPDATE wager_transactions
          SET next_attempt_at = ?, updated_at = ?
        WHERE provider_id = ?
          AND reference_external_transaction_id = ?
          AND wallet_id = ?
          AND status = 'PENDING_REFERENCE'
          AND next_attempt_at > ?`,
      [params.at, params.at, params.providerId, params.externalTransactionId, params.walletId, params.at],
    );
    return result.rowCount;
  }

  /**
   * Short claim transaction: due rows are locked with SKIP LOCKED (competing
   * workers take disjoint sets) and stamped with a lease, then committed by
   * the caller. Settlement itself happens later under the wallet lock and
   * re-checks the status, so an expired lease can never cause a double effect.
   */
  async claimDuePendingReferences(params: {
    now: Date;
    workerId: string;
    leaseUntil: Date;
    limit: number;
  }): Promise<PendingReferenceClaim[]> {
    const result = await sql<{ id: string; wallet_id: string }>(
      this.em,
      `WITH due AS (
         SELECT id
           FROM wager_transactions
          WHERE status = 'PENDING_REFERENCE'
            AND next_attempt_at <= ?
            AND (claim_expires_at IS NULL OR claim_expires_at < ?)
          ORDER BY next_attempt_at
          LIMIT ?
          FOR UPDATE SKIP LOCKED
       )
       UPDATE wager_transactions t
          SET claimed_by = ?, claim_expires_at = ?
         FROM due
        WHERE t.id = due.id
       RETURNING t.id, t.wallet_id`,
      [params.now, params.now, params.limit, params.workerId, params.leaseUntil],
    );
    return result.rows.map((row) => ({ transactionId: row.id, walletId: row.wallet_id }));
  }

  async pendingReferenceBacklog(
    now: Date,
  ): Promise<{ pending: number; due: number; oldestDueSeconds: number }> {
    const result = await sql<{ pending: number; due: number; oldest_due_seconds: number | null }>(
      this.em,
      `SELECT count(*)::int AS pending,
              count(*) FILTER (WHERE next_attempt_at <= ?)::int AS due,
              extract(epoch FROM (?::timestamptz - min(next_attempt_at) FILTER (WHERE next_attempt_at <= ?)))::float8 AS oldest_due_seconds
         FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE'`,
      [now, now, now],
    );
    const row = result.rows[0];
    return {
      pending: row?.pending ?? 0,
      due: row?.due ?? 0,
      oldestDueSeconds: Math.max(0, row?.oldest_due_seconds ?? 0),
    };
  }
}
