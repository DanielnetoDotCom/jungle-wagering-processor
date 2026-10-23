import { InboxMessage } from '../../domain/messaging/inbox-message';
import type { UnitOfWork } from '../ports/persistence.ports';
import type { Clock } from '../ports/runtime.ports';

export interface DeadLetterRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string | undefined;
  receiveCount: number;
  errorCode: string;
}

/**
 * Keeps permanent message failures auditable in the inbox (status
 * DEAD_LETTERED) next to the DLQ copy. A message already PROCESSED is never
 * touched. A later operator redrive of the same message id is processed
 * normally (with its failed-attempt count reset) and turns the row into PROCESSED.
 */
export class RecordDeadLetterUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(record: DeadLetterRecord): Promise<void> {
    await this.uow.run(async (scope) => {
      const existing = await scope.inbox.find(record.consumerName, record.messageId);
      if (existing?.isProcessed()) {
        return;
      }
      const message =
        existing ??
        InboxMessage.receive({
          messageId: record.messageId,
          consumerName: record.consumerName,
          payloadHash: record.payloadHash,
          receiveCount: record.receiveCount,
          receivedAt: this.clock.now(),
        });
      message.markDeadLettered(record.errorCode, record.receiveCount);
      scope.inbox.save(message);
      // An operator redrive from the DLQ starts with a full retry budget.
      await scope.inbox.resetAttempts(record.consumerName, record.messageId);
    });
  }
}
