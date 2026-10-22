import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from '../../../application/ports/runtime.ports';
import { currentLogContext } from '../../../infrastructure/logging/log-context';
import { describeError } from '../../../infrastructure/logging/logger';
import { toHttpError } from './http-errors';

/** Global filter: every error leaves the API in the unified JSON format. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId = currentLogContext().correlationId ?? 'unknown';
    const { status, body } = toHttpError(exception, correlationId);

    if (status >= 500) {
      this.logger.error('Request failed', { status, code: body.code, ...describeError(exception) });
    } else {
      this.logger.info('Request rejected', { status, code: body.code });
    }
    if (status === 503) {
      response.setHeader('Retry-After', '1');
    }
    if (!response.headersSent) {
      response.status(status).json(body);
    }
  }
}
