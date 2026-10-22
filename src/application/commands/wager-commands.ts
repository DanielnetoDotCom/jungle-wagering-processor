import type { MoneyProps } from '../../domain/money/money';
import type { TransactionChannel, WagerTransactionKind } from '../../domain/wagering/wager-transaction-types';

/** Business fields of a provider operation. Exactly these fields are hashed (see payload-hash.ts). */
export interface WagerTransactionPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface InboxEnvelope {
  consumerName: string;
  messageId: string;
  receiveCount: number;
}

/** Same command for HTTP and SQS: both entry points run the same use case. */
export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  payload: WagerTransactionPayload;
  channel: TransactionChannel.Http | TransactionChannel.Sqs;
  correlationId: string;
  causationId?: string | undefined;
  /** Present for SQS deliveries: the inbox row is written in the same SQL transaction. */
  inbox?: InboxEnvelope | undefined;
}

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}
