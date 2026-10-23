import type { UnitOfWork } from '../ports/persistence.ports';
import type { Clock } from '../ports/runtime.ports';

export interface FailedAttempt {
  consumerName: string;
  messageId: string;
  errorCode: string;
}

/**
 * Durable retry budget of a consumed message. It runs in its own short
 * transaction (the failed one rolled back) and counts only real processing
 * attempts: unlike SQS `ApproximateReceiveCount`, receiving a message that is
 * then postponed behind a failing FIFO group head does not consume its budget.
 */
export class RecordFailedAttemptUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  /** Returns how many attempts of this message have failed so far, this one included. */
  execute(attempt: FailedAttempt): Promise<number> {
    return this.uow.run((scope) => scope.inbox.recordFailedAttempt({ ...attempt, at: this.clock.now() }));
  }
}
