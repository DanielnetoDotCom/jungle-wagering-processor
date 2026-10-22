import type { LoggerService } from '@nestjs/common';
import pino, { type Logger as Pino } from 'pino';
import type { LogFields, Logger } from '../../application/ports/runtime.ports';
import { currentLogContext } from './log-context';

export interface LoggerOptions {
  level: string;
  serviceName: string;
  instanceId: string;
}

/**
 * JSON logs on stdout. Correlation identifiers come from AsyncLocalStorage.
 * Request/message bodies are never logged; known sensitive keys are redacted
 * as a second line of defence.
 */
export function createRootLogger(options: LoggerOptions): Pino {
  return pino({
    level: options.level,
    base: { service: options.serviceName, instanceId: options.instanceId },
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => ({ ...currentLogContext() }),
    redact: {
      paths: [
        'password',
        '*.password',
        'authorization',
        '*.authorization',
        'headers.authorization',
        'headers.cookie',
        'body',
        '*.body',
        'payload',
        '*.payload',
        'secretAccessKey',
        '*.secretAccessKey',
      ],
      censor: '[REDACTED]',
    },
  });
}

/** Application Logger port backed by pino. */
export class PinoLogger implements Logger {
  constructor(private readonly pino: Pino) {}

  debug(message: string, fields?: LogFields): void {
    this.pino.debug(fields ?? {}, message);
  }

  info(message: string, fields?: LogFields): void {
    this.pino.info(fields ?? {}, message);
  }

  warn(message: string, fields?: LogFields): void {
    this.pino.warn(fields ?? {}, message);
  }

  error(message: string, fields?: LogFields): void {
    this.pino.error(fields ?? {}, message);
  }

  child(bindings: LogFields): PinoLogger {
    return new PinoLogger(this.pino.child(bindings));
  }
}

/** Routes NestJS framework logs through the same JSON logger. */
export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly pino: Pino) {}

  log(message: unknown, ...optional: unknown[]): void {
    this.pino.info({ context: contextOf(optional) }, String(message));
  }

  error(message: unknown, ...optional: unknown[]): void {
    const [trace] = optional;
    this.pino.error(
      { context: contextOf(optional), trace: typeof trace === 'string' ? trace : undefined },
      String(message),
    );
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.pino.warn({ context: contextOf(optional) }, String(message));
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.pino.debug({ context: contextOf(optional) }, String(message));
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.pino.trace({ context: contextOf(optional) }, String(message));
  }

  fatal(message: unknown, ...optional: unknown[]): void {
    this.pino.fatal({ context: contextOf(optional) }, String(message));
  }
}

function contextOf(optional: unknown[]): string | undefined {
  const last = optional.at(-1);
  return typeof last === 'string' ? last : undefined;
}

export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(code !== undefined ? { errorCode: code } : {}),
      stack: error.stack,
    };
  }
  return { errorMessage: String(error) };
}
