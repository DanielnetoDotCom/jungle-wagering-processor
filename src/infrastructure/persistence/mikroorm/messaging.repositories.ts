import type { SqlEntityManager } from '@mikro-orm/postgresql';
import type {
  InboxRepository,
  OutboxBacklog,
  OutboxRepository,
} from '../../../application/ports/persistence.ports';
import type { InboxMessage } from '../../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { inboxData, outboxData, toInboxMessage, toOutboxMessage } from './mappers';
import { InboxMessageRecord, OutboxMessageRecord } from './records';
import { sql } from './sql';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageRecord, { consumerName, messageId }, { refresh: true });
    return record ? toInboxMessage(record) : undefined;
  }

  save(message: InboxMessage): void {
    const data = inboxData(message);
    // Composite primary key (consumer_name, message_id), in declaration order.
    const compositeKey = [message.consumerName, message.messageId] as unknown as InboxMessageRecord[];
    const managed = this.em
      .getUnitOfWork()
      .getById<InboxMessageRecord>(InboxMessageRecord.name, compositeKey);
    if (managed) {
      this.em.assign(managed, data);
    } else {
      this.em.persist(this.em.create(InboxMessageRecord, data));
    }
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  add(message: OutboxMessage): void {
    this.em.persist(this.em.create(OutboxMessageRecord, outboxData(message)));
  }

  /**
   * Claims due events in commit order. SKIP LOCKED lets concurrent publishers
   * take disjoint batches; the lease (claimed_by / claim_expires_at) is what
   * survives the commit, and an expired lease makes the event claimable again.
   */
  async claimDue(params: {
    now: Date;
    workerId: string;
    leaseUntil: Date;
    limit: number;
  }): Promise<OutboxMessage[]> {
    const claimed = await sql<{ id: string; seq: string }>(
      this.em,
      `WITH due AS (
         SELECT id
           FROM outbox_messages
          WHERE status = 'PENDING'
            AND next_attempt_at <= ?
            AND (claim_expires_at IS NULL OR claim_expires_at < ?)
          ORDER BY seq
          LIMIT ?
          FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox_messages o
          SET claimed_by = ?, claim_expires_at = ?, attempts = o.attempts + 1
         FROM due
        WHERE o.id = due.id
       RETURNING o.id, o.seq::text AS seq`,
      [params.now, params.now, params.limit, params.workerId, params.leaseUntil],
    );
    if (claimed.rows.length === 0) {
      return [];
    }
    const order = new Map(claimed.rows.map((row) => [row.id, BigInt(row.seq)]));
    const records = await this.em.find(
      OutboxMessageRecord,
      { id: { $in: [...order.keys()] } },
      { refresh: true },
    );
    return records
      .sort((a, b) => {
        const left = order.get(a.id) ?? 0n;
        const right = order.get(b.id) ?? 0n;
        return left < right ? -1 : left > right ? 1 : 0;
      })
      .map(toOutboxMessage);
  }

  async markPublished(ids: readonly string[], at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await sql(
      this.em,
      `UPDATE outbox_messages
          SET status = 'PUBLISHED', published_at = ?, claimed_by = NULL, claim_expires_at = NULL, last_error = NULL
        WHERE id = ANY(?::uuid[])
          AND status = 'PENDING'`,
      [at, [...ids]],
    );
    return result.rowCount;
  }

  async saveRetry(message: OutboxMessage, workerId: string): Promise<boolean> {
    const result = await sql(
      this.em,
      `UPDATE outbox_messages
          SET status = ?, next_attempt_at = ?, last_error = ?, claimed_by = NULL, claim_expires_at = NULL
        WHERE id = ?
          AND status = 'PENDING'
          AND claimed_by = ?`,
      [message.status, message.nextAttemptAt, message.lastError ?? null, message.id, workerId],
    );
    return result.rowCount === 1;
  }

  async backlog(now: Date): Promise<OutboxBacklog> {
    const result = await sql<{
      pending: number;
      due: number;
      dead: number;
      oldest_pending_seconds: number | null;
    }>(
      this.em,
      `SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
              count(*) FILTER (WHERE status = 'PENDING' AND next_attempt_at <= ?)::int AS due,
              count(*) FILTER (WHERE status = 'DEAD')::int AS dead,
              extract(epoch FROM (?::timestamptz - min(occurred_at) FILTER (WHERE status = 'PENDING')))::float8 AS oldest_pending_seconds
         FROM outbox_messages
        WHERE status IN ('PENDING', 'DEAD')`,
      [now, now],
    );
    const row = result.rows[0];
    return {
      pending: row?.pending ?? 0,
      due: row?.due ?? 0,
      dead: row?.dead ?? 0,
      oldestPendingSeconds: Math.max(0, row?.oldest_pending_seconds ?? 0),
    };
  }
}
