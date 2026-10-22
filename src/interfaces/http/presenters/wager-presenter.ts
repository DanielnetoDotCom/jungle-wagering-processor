import { ConflictError, ResourceNotFoundError } from '../../../application/errors/application-errors';
import type { WagerSubmissionResult } from '../../../application/use-cases/process-wager-transaction.use-case';
import type { WagerTransactionView } from '../../../application/views';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-types';

export interface PresentedResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Maps the use case result to HTTP. A replay returns the ORIGINAL outcome
 * (same status semantics and the balance observed at the time) with
 * `idempotentReplay: true`:
 *   PROCESSED          -> 201 (first time) / 200 (replay)
 *   PENDING_REFERENCE  -> 202 + Location to poll
 *   REJECTED           -> 422 + failureCode (error envelope + transaction fields)
 *   FAILED             -> 500 + failureCode (terminal, not retryable)
 *   conflicts          -> 409, unknown wallet -> 404
 */
export function presentSubmission(result: WagerSubmissionResult, correlationId: string): PresentedResponse {
  switch (result.type) {
    case 'RECORDED':
      return presentTransaction(result.transaction, false, correlationId);
    case 'REPLAY':
      return presentTransaction(result.transaction, true, correlationId);
    case 'CONFLICT':
      throw new ConflictError(
        result.code,
        result.code === 'IDEMPOTENCY_KEY_CONFLICT'
          ? 'Idempotency-Key was already used with a different payload'
          : 'externalTransactionId was already submitted with a different Idempotency-Key',
        { existingTransactionId: result.existingTransactionId },
      );
    case 'WALLET_NOT_FOUND':
      throw new ResourceNotFoundError(
        'WALLET_NOT_FOUND',
        'The wallet referenced by the transaction does not exist',
      );
    case 'DUPLICATE_MESSAGE':
    case 'MESSAGE_ID_CONFLICT':
      throw new Error(`Unexpected ${result.type} result on the HTTP channel`);
  }
}

function presentTransaction(
  view: WagerTransactionView,
  replay: boolean,
  correlationId: string,
): PresentedResponse {
  const location = `/wagering/transactions/${view.transactionId}`;
  const headers: Record<string, string> = {
    Location: location,
    ...(replay ? { 'Idempotent-Replayed': 'true' } : {}),
  };
  const result = {
    transactionId: view.transactionId,
    externalTransactionId: view.externalTransactionId,
    kind: view.kind,
    status: view.status,
    balance: view.balance,
    walletVersion: view.walletVersion,
    idempotentReplay: replay,
  };

  switch (view.status) {
    case WagerTransactionStatus.Processed:
      return { status: replay ? 200 : 201, headers, body: result };
    case WagerTransactionStatus.PendingReference:
      return {
        status: 202,
        headers,
        body: {
          ...result,
          nextAttemptAt: view.nextAttemptAt,
          referenceExternalTransactionId: view.referenceExternalTransactionId,
        },
      };
    case WagerTransactionStatus.Rejected:
      return {
        status: 422,
        headers,
        body: {
          code: view.failureCode,
          message: `Transaction rejected: ${view.failureCode ?? 'unknown'}`,
          correlationId,
          retryable: false,
          failureCode: view.failureCode,
          ...result,
        },
      };
    case WagerTransactionStatus.Failed:
    case WagerTransactionStatus.Pending: // never persisted; treated as a failure if ever observed
      return {
        status: 500,
        headers,
        body: {
          code: view.failureCode ?? 'PROCESSING_FAILED',
          message: 'Transaction failed permanently and was not applied',
          correlationId,
          retryable: false,
          failureCode: view.failureCode,
          ...result,
        },
      };
  }
}
