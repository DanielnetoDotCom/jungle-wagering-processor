import { InvalidTransactionStateError } from '../errors/domain-errors';

export enum InboxStatus {
  /** In memory only: the row is written in the same SQL transaction that processes it. */
  Received = 'RECEIVED',
  Processed = 'PROCESSED',
  /** Sent to the DLQ; may be processed later if an operator redrives it. */
  DeadLettered = 'DEAD_LETTERED',
}

/** What processing the message produced, so redeliveries can be answered without reprocessing. */
export enum InboxOutcome {
  /** A new wager transaction was recorded (whatever its status). */
  Applied = 'APPLIED',
  /** The idempotency key already existed with the same payload. */
  Replayed = 'REPLAYED',
  /** Idempotency key or externalTransactionId reused with a different payload. */
  Conflict = 'CONFLICT',
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** Permanent error: invalid contract or message id reused. */
  Rejected = 'REJECTED',
}

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string | undefined;
  receiveCount: number;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  status: InboxStatus;
  outcome: InboxOutcome | undefined;
  transactionId: string | undefined;
  resultCode: string | undefined;
  processedAt: Date | undefined;
}

/** Persistent deduplication record keyed by (consumerName, messageId). */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    private _payloadHash: string | undefined,
    private readonly _receivedAt: Date,
    private _receiveCount: number,
    private _status: InboxStatus,
    private _outcome: InboxOutcome | undefined,
    private _transactionId: string | undefined,
    private _resultCode: string | undefined,
    private _processedAt: Date | undefined,
  ) {
    this._receivedAt = new Date(_receivedAt.getTime());
    this._processedAt = _processedAt && new Date(_processedAt.getTime());
  }

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
      props.receiveCount,
      InboxStatus.Received,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.receiveCount,
      state.status,
      state.outcome,
      state.transactionId,
      state.resultCode,
      state.processedAt,
    );
  }

  get status(): InboxStatus {
    return this._status;
  }

  /** Hash of the payload this message id was processed with (fixed once PROCESSED). */
  get payloadHash(): string | undefined {
    return this._payloadHash;
  }

  get processedAt(): Date | undefined {
    return this._processedAt && new Date(this._processedAt.getTime());
  }

  get receivedAt(): Date {
    return new Date(this._receivedAt.getTime());
  }

  get outcome(): InboxOutcome | undefined {
    return this._outcome;
  }

  get transactionId(): string | undefined {
    return this._transactionId;
  }

  get resultCode(): string | undefined {
    return this._resultCode;
  }

  get receiveCount(): number {
    return this._receiveCount;
  }

  isProcessed(): boolean {
    return this._status === InboxStatus.Processed;
  }

  matchesPayload(payloadHash: string): boolean {
    return this._payloadHash === payloadHash;
  }

  markProcessed(
    at: Date,
    result: { outcome: InboxOutcome; transactionId?: string | undefined; resultCode?: string | undefined },
  ): void {
    if (this._status === InboxStatus.Processed) {
      throw new InvalidTransactionStateError(`Inbox message ${this.messageId} was already processed`);
    }
    if (this._payloadHash === undefined) {
      throw new InvalidTransactionStateError(
        `Inbox message ${this.messageId} has no payload hash to be processed with`,
      );
    }
    this._status = InboxStatus.Processed;
    this._outcome = result.outcome;
    this._transactionId = result.transactionId;
    this._resultCode = result.resultCode;
    this._processedAt = new Date(at.getTime());
  }

  markDeadLettered(errorCode: string, receiveCount: number): void {
    if (this._status === InboxStatus.Processed) {
      throw new InvalidTransactionStateError(`Inbox message ${this.messageId} was already processed`);
    }
    this._status = InboxStatus.DeadLettered;
    this._outcome = InboxOutcome.Rejected;
    this._resultCode = errorCode;
    this._receiveCount = receiveCount;
  }

  /**
   * A new delivery of a message id that was never PROCESSED (e.g. dead-lettered,
   * then redriven or resent corrected). It is processed again, and the payload
   * actually processed this time becomes the one later redeliveries must match.
   */
  registerRedelivery(receiveCount: number, payloadHash: string): void {
    if (this._status === InboxStatus.Processed) {
      throw new InvalidTransactionStateError(`Inbox message ${this.messageId} was already processed`);
    }
    this._payloadHash = payloadHash;
    this._receiveCount = Math.max(this._receiveCount, receiveCount);
  }
}
