import { AsyncLocalStorage } from 'node:async_hooks';

/** Diagnostic identifiers propagated through every log line of one request/message. */
export interface LogContext {
  correlationId?: string;
  requestId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with a context that inherits the current one; async continuations keep it. */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...withoutUndefined(context) }, fn);
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}

/** Adds identifiers discovered later (e.g. walletId after parsing a message) to the active context. */
export function enrichLogContext(context: LogContext): void {
  const store = storage.getStore();
  if (store) {
    Object.assign(store, withoutUndefined(context));
  }
}

function withoutUndefined(context: LogContext): LogContext {
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));
}
