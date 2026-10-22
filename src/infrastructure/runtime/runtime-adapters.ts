import { v7 as uuidv7 } from 'uuid';
import type {
  Clock,
  FaultInjector,
  FaultPoint,
  IdGenerator,
  Logger,
} from '../../application/ports/runtime.ports';
import { sleep } from '../../shared/sleep';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** RFC 9562 UUIDv7: time-ordered ids keep B-tree inserts local. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}

type FaultAction = { type: 'crash' } | { type: 'throw' } | { type: 'delay'; ms: number };

export class InjectedFaultError extends Error {
  constructor(point: FaultPoint) {
    super(`Injected fault at ${point}`);
    this.name = 'InjectedFaultError';
  }
}

/**
 * Test-only fault injection driven by FAULT_INJECTION, e.g.
 *   FAULT_INJECTION="consumer.after-commit-before-ack=crash"
 * `crash` sends SIGKILL to the current process (no graceful shutdown, exactly
 * like a container being killed). Disabled unless FAULT_INJECTION_ENABLED=true,
 * and refused by the configuration loader in production.
 */
export class EnvFaultInjector implements FaultInjector {
  private readonly actions: Map<string, FaultAction>;

  constructor(enabled: boolean, spec: string, logger: Logger) {
    this.actions = enabled ? parse(spec) : new Map<string, FaultAction>();
    if (this.actions.size > 0) {
      logger.warn('FAULT INJECTION ACTIVE - test environment only', { faults: [...this.actions.keys()] });
    }
  }

  async checkpoint(point: FaultPoint): Promise<void> {
    const action = this.actions.get(point);
    if (!action) return;
    switch (action.type) {
      case 'crash':
        process.kill(process.pid, 'SIGKILL');
        await sleep(60_000); // never resumes
        return;
      case 'throw':
        throw new InjectedFaultError(point);
      case 'delay':
        await sleep(action.ms);
        return;
    }
  }
}

function parse(spec: string): Map<string, FaultAction> {
  const actions = new Map<string, FaultAction>();
  for (const item of spec
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [point, rawAction = 'crash'] = item.split('=');
    if (!point) continue;
    if (rawAction === 'crash' || rawAction === 'throw') {
      actions.set(point, { type: rawAction });
    } else if (rawAction.startsWith('delay:')) {
      actions.set(point, { type: 'delay', ms: Number.parseInt(rawAction.slice('delay:'.length), 10) || 0 });
    }
  }
  return actions;
}
