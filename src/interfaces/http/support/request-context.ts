import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '../../../application/ports/runtime.ports';
import { currentLogContext, runWithLogContext } from '../../../infrastructure/logging/log-context';
import type { PrometheusMetrics } from '../../../infrastructure/metrics/prometheus-metrics';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function headerId(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}

export function currentCorrelationId(): string {
  return currentLogContext().correlationId ?? randomUUID();
}

export function currentRequestId(): string | undefined {
  return currentLogContext().requestId;
}

/**
 * First middleware of the chain: establishes correlation/request ids
 * (propagated from X-Correlation-Id / X-Request-Id when well-formed), echoes
 * them back, tags the responding instance, and records an access log line
 * plus HTTP metrics on completion. Bodies are never logged.
 */
export function requestContextMiddleware(instanceId: string, logger: Logger, metrics: PrometheusMetrics) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const correlationId = headerId(request, 'x-correlation-id') ?? randomUUID();
    const requestId = headerId(request, 'x-request-id') ?? randomUUID();
    const startedAt = performance.now();

    response.setHeader('X-Correlation-Id', correlationId);
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('X-Instance-Id', instanceId);

    runWithLogContext({ correlationId, requestId }, () => {
      response.on('finish', () => {
        const route = (request.route as { path?: string } | undefined)?.path ?? 'unmatched';
        const seconds = (performance.now() - startedAt) / 1000;
        metrics.httpRequest(request.method, route, response.statusCode, seconds);
        if (!route.startsWith('/health') && route !== '/metrics') {
          logger.info('HTTP request completed', {
            method: request.method,
            route,
            status: response.statusCode,
            durationMs: Math.round(seconds * 1000),
          });
        }
      });
      next();
    });
  };
}

/** Turns body-parser failures (malformed JSON, oversized body) into the unified error format. */
export function bodyParserErrorHandler() {
  return (error: unknown, _request: Request, response: Response, next: NextFunction): void => {
    const type = (error as { type?: unknown } | null)?.type;
    if (type !== 'entity.parse.failed' && type !== 'entity.too.large' && type !== 'encoding.unsupported') {
      next(error);
      return;
    }
    const tooLarge = type === 'entity.too.large';
    response.status(tooLarge ? 413 : 400).json({
      code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR',
      message: tooLarge ? 'Request body is too large' : 'Request body is not valid JSON',
      correlationId: currentLogContext().correlationId ?? 'unknown',
      retryable: false,
    });
  };
}
