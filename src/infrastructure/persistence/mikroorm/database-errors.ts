import { ConnectionException } from '@mikro-orm/core';
import {
  ApplicationError,
  IntegrityViolationError,
  TransientInfrastructureError,
  UniqueConstraintRaceError,
} from '../../../application/errors/application-errors';
import { DomainError } from '../../../domain/errors/domain-errors';

/** PostgreSQL SQLSTATEs / socket errors meaning "the database is not reachable right now". */
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
  '3D000', // invalid_catalog_name (database missing or being recreated)
]);

const INTEGRITY_CODES = new Set([
  '23000', // integrity_constraint_violation (raised by our append-only triggers)
  '23001', // restrict_violation
  '23502', // not_null_violation
  '23503', // foreign_key_violation
  '23514', // check_violation (CHECKs and validation triggers)
  'P0001', // raise_exception
]);

const UNAVAILABLE_MESSAGE =
  /Connection terminated|connect ECONNREFUSED|Timeout acquiring a connection|Client has encountered a connection error|Connection ended unexpectedly|terminating connection|not currently accepting connections|the database system is (starting up|shutting down)/i;

/**
 * Maps driver errors to application errors so callers branch on categories,
 * not on driver internals:
 *  - deadlock / serialization / lock timeout / lost unique race -> transient, retry the unit of work
 *  - connection problems                                       -> transient, surface (503 / SQS retry)
 *  - CHECK / FK / trigger violations                           -> integrity violation (a bug), never retried
 */
export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof ApplicationError || error instanceof DomainError || !(error instanceof Error)) {
    return error;
  }
  const code = stringProperty(error, 'code');
  const constraint = stringProperty(error, 'constraint');

  switch (code) {
    case '40P01':
      return new TransientInfrastructureError(
        'CONCURRENCY_CONFLICT',
        'Deadlock detected; transaction rolled back',
        'deadlock',
        error,
      );
    case '40001':
      return new TransientInfrastructureError(
        'CONCURRENCY_CONFLICT',
        'Serialization failure; transaction rolled back',
        'serialization',
        error,
      );
    case '55P03':
      return new TransientInfrastructureError(
        'LOCK_TIMEOUT',
        'Timed out waiting for a row lock',
        'lock_timeout',
        error,
      );
    case '57014':
      return new TransientInfrastructureError('STATEMENT_TIMEOUT', 'Statement timed out', undefined, error);
    case '23505':
      return new UniqueConstraintRaceError(constraint, error);
    default:
      break;
  }
  if (code !== undefined && INTEGRITY_CODES.has(code)) {
    return new IntegrityViolationError(
      constraint,
      `Database integrity rule rejected the write: ${error.message}`,
      error,
    );
  }
  if (
    error instanceof ConnectionException ||
    error.name === 'KnexTimeoutError' ||
    (code !== undefined && (UNAVAILABLE_CODES.has(code) || code.startsWith('08'))) ||
    UNAVAILABLE_MESSAGE.test(error.message)
  ) {
    return new TransientInfrastructureError(
      'DATABASE_UNAVAILABLE',
      'Database is temporarily unavailable',
      undefined,
      error,
    );
  }
  return error;
}

function stringProperty(error: Error, key: string): string | undefined {
  const value = (error as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
