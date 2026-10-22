import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';

export interface WalletLockResult {
  wallet: Wallet | undefined;
  /** True when another transaction was holding the row and we had to wait. */
  contended: boolean;
  waitSeconds: number;
}

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  /**
   * Row-level `SELECT ... FOR UPDATE` on the wallet. This is THE concurrency
   * control for balances: it serializes every financial change of one wallet
   * across all processes, while different wallets proceed in parallel.
   */
  lockById(id: string): Promise<WalletLockResult>;
  /** Tracks a new or changed wallet; written on flush/commit. */
  save(wallet: Wallet): void;
}

export interface PendingReferenceClaim {
  transactionId: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** `SELECT ... FOR UPDATE`. Callers must already hold the wallet lock (lock order: wallet -> transaction). */
  lockById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Whether a PROCESSED REFUND/ROLLBACK already points at this transaction. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  save(transaction: WagerTransaction): void;
  /**
   * Makes PENDING_REFERENCE transactions of the same wallet that wait for
   * `externalTransactionId` immediately due, so the worker resolves them
   * without waiting for their backoff. Returns how many were woken up.
   */
  wakeDependents(params: {
    providerId: string;
    externalTransactionId: string;
    walletId: string;
    at: Date;
  }): Promise<number>;
  /** Claims due PENDING_REFERENCE rows with FOR UPDATE SKIP LOCKED and a lease. */
  claimDuePendingReferences(params: {
    now: Date;
    workerId: string;
    leaseUntil: Date;
    limit: number;
  }): Promise<PendingReferenceClaim[]>;
  pendingReferenceBacklog(now: Date): Promise<{ pending: number; due: number; oldestDueSeconds: number }>;
}

export interface LedgerPageQuery {
  walletId: string;
  /** Exclusive keyset bound on wallet_version. */
  afterVersion: number | undefined;
  limit: number;
  order: 'asc' | 'desc';
}

export interface LedgerSummary {
  entries: number;
  /** Σ credits − Σ debits, computed with exact NUMERIC arithmetic. */
  signedTotal: Money;
  lastVersion: number | undefined;
  /** Entries whose balance_before does not equal the previous balance_after (or versions with gaps). */
  chainBreaks: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): void;
  page(query: LedgerPageQuery): Promise<WalletLedgerEntry[]>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  save(message: InboxMessage): void;
}

export interface OutboxBacklog {
  pending: number;
  due: number;
  dead: number;
  /** Age of the oldest PENDING event (0 when empty): the outbox lag. */
  oldestPendingSeconds: number;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
  /** Claims due events (FOR UPDATE SKIP LOCKED), stamps a lease and increments attempts. */
  claimDue(params: {
    now: Date;
    workerId: string;
    leaseUntil: Date;
    limit: number;
  }): Promise<OutboxMessage[]>;
  /** Marks events as published. Idempotent; does not require the lease (publication already happened). */
  markPublished(ids: readonly string[], at: Date): Promise<number>;
  /** Persists a retry/dead decision, only if `workerId` still owns the lease. */
  saveRetry(message: OutboxMessage, workerId: string): Promise<boolean>;
  backlog(now: Date): Promise<OutboxBacklog>;
}

/** Repositories bound to one open SQL transaction. */
export interface TransactionalScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
  /** Sends pending writes inside the open transaction (constraint violations surface here). */
  flush(): Promise<void>;
  /** Best-effort synchronous observations, run only after a successful COMMIT. Not durable event delivery. */
  afterCommit(observe: () => void): void;
}

export interface UnitOfWorkOptions {
  isolation?: 'read committed' | 'repeatable read';
  readOnly?: boolean;
}

/**
 * Runs `work` inside ONE PostgreSQL transaction: everything tracked by the
 * scope is committed together or rolled back together. Implementations
 * translate driver errors into application errors (transient vs integrity).
 */
export interface UnitOfWork {
  run<T>(work: (scope: TransactionalScope) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
