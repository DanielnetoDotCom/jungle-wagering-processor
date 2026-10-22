import { HttpException } from '@nestjs/common';
import { ApplicationError, ErrorCategory } from '../../../application/errors/application-errors';
import {
  DomainError,
  InvalidTransactionStateError,
  InvariantViolationError,
} from '../../../domain/errors/domain-errors';

/**
 * Single error format for every endpoint. `code` and `retryable` are the
 * machine-readable contract; `message` is for humans only.
 */
export interface ErrorBody {
  code: string;
  message: string;
  correlationId: string;
  retryable: boolean;
  details?: Readonly<Record<string, unknown>>;
}

export interface HttpError {
  status: number;
  body: ErrorBody;
}

/**
 * Status mapping (consistent across endpoints):
 *   400 invalid payload/parameters      404 resource not found
 *   409 identity/idempotency conflict   422 business rule rejection
 *   202 accepted, still pending         503 transient infrastructure failure
 *   500 unexpected/internal error
 */
export const STATUS_BY_CATEGORY: Readonly<Record<ErrorCategory, number>> = {
  [ErrorCategory.Validation]: 400,
  [ErrorCategory.Forbidden]: 403,
  [ErrorCategory.NotFound]: 404,
  [ErrorCategory.Conflict]: 409,
  [ErrorCategory.BusinessRule]: 422,
  [ErrorCategory.Transient]: 503,
  [ErrorCategory.Internal]: 500,
};

export function toHttpError(error: unknown, correlationId: string): HttpError {
  if (error instanceof ApplicationError) {
    const internal = error.category === ErrorCategory.Internal;
    return {
      status: STATUS_BY_CATEGORY[error.category],
      body: {
        code: error.code,
        // Never leak SQL or constraint internals to clients.
        message: internal ? 'Internal integrity error; the operation was not applied' : error.message,
        correlationId,
        retryable: error.retryable,
        ...(error.details && !internal ? { details: error.details } : {}),
      },
    };
  }
  if (error instanceof DomainError) {
    if (error instanceof InvariantViolationError || error instanceof InvalidTransactionStateError) {
      return internalError(correlationId);
    }
    const field = (error as { field?: unknown }).field;
    return {
      status: 400,
      body: {
        code: error.code,
        message: error.message,
        correlationId,
        retryable: false,
        ...(typeof field === 'string' ? { details: { field } } : {}),
      },
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = status === 404 ? 'ROUTE_NOT_FOUND' : status === 413 ? 'PAYLOAD_TOO_LARGE' : `HTTP_${status}`;
    return { status, body: { code, message: error.message, correlationId, retryable: status >= 500 } };
  }
  return internalError(correlationId);
}

function internalError(correlationId: string): HttpError {
  return {
    status: 500,
    body: {
      code: 'INTERNAL_ERROR',
      message: 'Unexpected error; the operation was not applied',
      correlationId,
      retryable: false,
    },
  };
}
