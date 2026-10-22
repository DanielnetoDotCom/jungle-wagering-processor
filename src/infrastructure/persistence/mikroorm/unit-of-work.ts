import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM, SqlEntityManager } from '@mikro-orm/postgresql';
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  TransactionalScope,
  UnitOfWork,
  UnitOfWorkOptions,
  WagerTransactionRepository,
  WalletRepository,
} from '../../../application/ports/persistence.ports';
import { translateDatabaseError } from './database-errors';
import type { Logger } from '../../../application/ports/runtime.ports';
import { MikroOrmLedgerRepository } from './ledger.repository';
import { MikroOrmInboxRepository, MikroOrmOutboxRepository } from './messaging.repositories';
import { MikroOrmWagerTransactionRepository } from './wager-transaction.repository';
import { MikroOrmWalletRepository } from './wallet.repository';

class MikroOrmTransactionalScope implements TransactionalScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;

  constructor(
    private readonly em: SqlEntityManager,
    private readonly observations: Array<() => void>,
  ) {
    this.wallets = new MikroOrmWalletRepository(em);
    this.transactions = new MikroOrmWagerTransactionRepository(em);
    this.ledger = new MikroOrmLedgerRepository(em);
    this.inbox = new MikroOrmInboxRepository(em);
    this.outbox = new MikroOrmOutboxRepository(em);
  }

  flush(): Promise<void> {
    return this.em.flush();
  }

  afterCommit(observe: () => void): void {
    this.observations.push(observe);
  }
}

/**
 * MikroORM Unit of Work = one PostgreSQL transaction. A fresh forked
 * EntityManager per call isolates the identity map of concurrent requests;
 * `em.transactional` flushes tracked changes and COMMITs, or ROLLs BACK on
 * any error, so no partial state can survive a failure.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly logger: Logger,
  ) {}

  async run<T>(work: (scope: TransactionalScope) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    const em = this.orm.em.fork({ clear: true, useContext: false });
    const observations: Array<() => void> = [];
    let result: T;
    try {
      result = await em.transactional(
        (transactionEm) => work(new MikroOrmTransactionalScope(transactionEm, observations)),
        {
          isolationLevel:
            options.isolation === 'repeatable read'
              ? IsolationLevel.REPEATABLE_READ
              : IsolationLevel.READ_COMMITTED,
          readOnly: options.readOnly ?? false,
        },
      );
    } catch (error) {
      throw translateDatabaseError(error);
    }
    // A failed metric must never turn an already committed financial operation
    // into an apparent failure, nor cause the transaction retry loop to run again.
    for (const observe of observations) {
      try {
        observe();
      } catch {
        try {
          this.logger.error('Post-commit observation failed');
        } catch {
          // COMMIT has succeeded even if the observation and its logger fail.
        }
      }
    }
    return result;
  }
}
