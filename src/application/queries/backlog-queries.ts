import type { OutboxBacklog, UnitOfWork } from '../ports/persistence.ports';
import type { Clock } from '../ports/runtime.ports';

/** Operational gauges (outbox lag, pending references) refreshed periodically by the workers. */
export class BacklogQueries {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  outbox(): Promise<OutboxBacklog> {
    return this.uow.run((scope) => scope.outbox.backlog(this.clock.now()), { readOnly: true });
  }

  pendingReferences(): Promise<{ pending: number; due: number; oldestDueSeconds: number }> {
    return this.uow.run((scope) => scope.transactions.pendingReferenceBacklog(this.clock.now()), {
      readOnly: true,
    });
  }
}
