import {
  DomainValidationError,
  InvalidTransactionStateError,
  InvariantViolationError,
} from '../errors/domain-errors';
import { LedgerDirection, oppositeDirection } from '../ledger/ledger-direction';
import { Money } from '../money/money';
import {
  FailureCode,
  TERMINAL_STATUSES,
  TransactionChannel,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction-types';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  channel: TransactionChannel;
  walletId: string;
  playerId: string;
  /** Required for every provider kind; absent only for the internal OPENING. */
  roundId: string | undefined;
  gameId: string | undefined;
  kind: WagerTransactionKind;
  money: Money;
  /** Provider-side id of the referenced transaction (not the internal id). */
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
}

/** Wallet balance/version observed when the transaction reached its current state. */
export interface TransactionResult {
  balance: Money;
  walletVersion: number;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  result: TransactionResult | undefined;
  referenceAttempts: number;
  nextAttemptAt: Date | undefined;
  referenceExpiresAt: Date | undefined;
  updatedAt: Date;
}

/**
 * Explicit state machine. Terminal states (PROCESSED, REJECTED, FAILED) have
 * no outgoing transitions; trying one is a programming error.
 *
 *   PENDING ──────────────┬──> PROCESSED
 *      │                  ├──> REJECTED
 *      v                  └──> FAILED
 *   PENDING_REFERENCE ────┬──> PROCESSED
 *      (retry: self)      ├──> REJECTED   (e.g. REFERENCE_NOT_FOUND after TTL)
 *                         └──> FAILED
 */
const ALLOWED_TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

/** Which kinds each kind may reference. Empty => must not carry a reference. */
const REFERENCEABLE_KINDS: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly channel: TransactionChannel,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | undefined,
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _result: TransactionResult | undefined,
    private _referenceAttempts: number,
    private _nextAttemptAt: Date | undefined,
    private _referenceExpiresAt: Date | undefined,
    private _updatedAt: Date,
  ) {}

  /** Born PENDING. Validates channel and reference requirements per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.validate(props);
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.channel,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      props.createdAt,
    );
  }

  /** Reconstruction from persistence: state is trusted, no transition is re-validated. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.channel,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.result,
      state.referenceAttempts,
      state.nextAttemptAt,
      state.referenceExpiresAt,
      state.updatedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  /** Moment the transaction reached a terminal state. */
  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /** Snapshot returned on idempotent replays: the balance observed at the time, not the current one. */
  get result(): TransactionResult | undefined {
    return this._result;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get referenceExpiresAt(): Date | undefined {
    return this._referenceExpiresAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transitions ---------------------------------------------------------

  markProcessed(props: {
    referenceTransactionId: string | undefined;
    at: Date;
    result: TransactionResult;
  }): void {
    this.assertTransition(WagerTransactionStatus.Processed);
    if (this.hasReference() && props.referenceTransactionId === undefined) {
      throw new InvariantViolationError(
        'A transaction with a reference must be processed against a resolved reference',
      );
    }
    if (!this.hasReference() && props.referenceTransactionId !== undefined) {
      throw new InvariantViolationError('A transaction without a reference cannot be linked to one');
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this.settle(props.at, props.result);
  }

  markPendingReference(props: {
    at: Date;
    nextAttemptAt: Date;
    expiresAt: Date;
    result: TransactionResult;
  }): void {
    this.assertTransition(WagerTransactionStatus.PendingReference);
    if (!this.hasReference()) {
      throw new InvariantViolationError('Only transactions with a reference can wait for it');
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = props.nextAttemptAt;
    this._referenceExpiresAt = props.expiresAt;
    this._result = props.result;
    this._updatedAt = props.at;
  }

  /** Counts one worker attempt to resolve the reference, whatever its outcome. */
  registerReferenceAttempt(at: Date): void {
    this.assertWaitingForReference();
    this._referenceAttempts += 1;
    this._updatedAt = at;
  }

  /** The attempt did not settle the transaction: it stays PENDING_REFERENCE until `nextAttemptAt`. */
  scheduleReferenceRetry(props: { at: Date; nextAttemptAt: Date }): void {
    this.assertWaitingForReference();
    this._nextAttemptAt = props.nextAttemptAt;
    this._updatedAt = props.at;
  }

  reject(code: FailureCode, props: { at: Date; result: TransactionResult }): void {
    this.assertTransition(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this.settle(props.at, props.result);
  }

  fail(code: FailureCode, props: { at: Date; result: TransactionResult }): void {
    this.assertTransition(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this.settle(props.at, props.result);
  }

  // ---- domain queries ------------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** false only for LOSS: it records the round outcome without moving money. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** REFUND and ROLLBACK cannot exist without a reference. */
  requiresReference(): boolean {
    return this.isReversal();
  }

  isReversal(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  canReference(kind: WagerTransactionKind): boolean {
    return REFERENCEABLE_KINDS[this.kind].includes(kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Attributes in which a referenced transaction differs from this one. A
   * reference must belong to the same provider, player, wallet, currency and
   * round.
   */
  referenceMismatches(reference: WagerTransaction): string[] {
    const mismatches: string[] = [];
    if (reference.providerId !== this.providerId) mismatches.push('providerId');
    if (reference.externalTransactionId !== this.referenceExternalTransactionId) {
      mismatches.push('externalTransactionId');
    }
    if (reference.playerId !== this.playerId) mismatches.push('playerId');
    if (reference.walletId !== this.walletId) mismatches.push('walletId');
    if (reference.money.currency !== this.money.currency) mismatches.push('currency');
    if (reference.roundId !== this.roundId) mismatches.push('roundId');
    return mismatches;
  }

  /**
   * Direction of the ledger line this transaction produces. ROLLBACK applies
   * the inverse of its reference: rollback of a BET credits, rollback of a WIN
   * or REFUND debits.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference || !this.canReference(reference.kind)) {
          throw new InvariantViolationError(
            'ROLLBACK direction depends on a valid BET, WIN or REFUND reference',
          );
        }
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS has no financial effect and therefore no ledger direction');
    }
  }

  private settle(at: Date, result: TransactionResult): void {
    this._processedAt = at;
    this._updatedAt = at;
    this._result = result;
    this._nextAttemptAt = undefined;
  }

  private assertWaitingForReference(): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `Transaction ${this.id} is ${this._status}, not PENDING_REFERENCE`,
      );
    }
  }

  private assertTransition(target: WagerTransactionStatus): void {
    if (!ALLOWED_TRANSITIONS[this._status].includes(target)) {
      throw new InvalidTransactionStateError(
        `Transaction ${this.id} cannot move from ${this._status} to ${target}`,
      );
    }
  }

  private static validate(props: CreateWagerTransactionProps): void {
    const required: Array<[string, string | undefined]> = [
      ['id', props.id],
      ['providerId', props.providerId],
      ['externalTransactionId', props.externalTransactionId],
      ['idempotencyKey', props.idempotencyKey],
      ['walletId', props.walletId],
      ['playerId', props.playerId],
    ];
    for (const [field, value] of required) {
      if (value === undefined || value.trim() === '') {
        throw new DomainValidationError(`${field} is required`, field);
      }
    }
    if (!HASH_PATTERN.test(props.payloadHash)) {
      throw new DomainValidationError('payloadHash must be a lowercase SHA-256 hex digest', 'payloadHash');
    }

    const isOpening = props.kind === WagerTransactionKind.Opening;
    if (isOpening !== (props.channel === TransactionChannel.Internal)) {
      throw new DomainValidationError(
        'OPENING is internal only and the internal channel only creates OPENING',
        'kind',
      );
    }
    if (!isOpening && (!props.roundId?.trim() || !props.gameId?.trim())) {
      throw new DomainValidationError('roundId and gameId are required', 'roundId');
    }

    const allowedReferences = REFERENCEABLE_KINDS[props.kind];
    const reference = props.referenceExternalTransactionId;
    if (reference !== undefined && reference.trim() === '') {
      throw new DomainValidationError(
        'referenceExternalTransactionId cannot be blank',
        'referenceExternalTransactionId',
      );
    }
    if (reference !== undefined && allowedReferences.length === 0) {
      throw new DomainValidationError(
        `${props.kind} cannot reference another transaction`,
        'referenceExternalTransactionId',
      );
    }
    if (
      reference === undefined &&
      (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback)
    ) {
      throw new DomainValidationError(
        `${props.kind} requires referenceExternalTransactionId`,
        'referenceExternalTransactionId',
      );
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new DomainValidationError(
        'A transaction cannot reference itself',
        'referenceExternalTransactionId',
      );
    }

    if (props.money.isNegative()) {
      throw new DomainValidationError('Transaction amount cannot be negative', 'money');
    }
    if (props.kind !== WagerTransactionKind.Loss && props.money.isZero()) {
      throw new DomainValidationError(`${props.kind} amount must be greater than zero`, 'money');
    }
  }
}
