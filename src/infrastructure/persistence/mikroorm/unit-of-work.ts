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

  constructor(private readonly em: SqlEntityManager) {
    this.wallets = new MikroOrmWalletRepository(em);
    this.transactions = new MikroOrmWagerTransactionRepository(em);
    this.ledger = new MikroOrmLedgerRepository(em);
    this.inbox = new MikroOrmInboxRepository(em);
    this.outbox = new MikroOrmOutboxRepository(em);
  }

  flush(): Promise<void> {
    return this.em.flush();
  }
}

/**
 * MikroORM Unit of Work = one PostgreSQL transaction. A fresh forked
 * EntityManager per call isolates the identity map of concurrent requests;
 * `em.transactional` flushes tracked changes and COMMITs, or ROLLs BACK on
 * any error, so no partial state can survive a failure.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(work: (scope: TransactionalScope) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    const em = this.orm.em.fork({ clear: true, useContext: false });
    try {
      return await em.transactional((transactionEm) => work(new MikroOrmTransactionalScope(transactionEm)), {
        isolationLevel:
          options.isolation === 'repeatable read'
            ? IsolationLevel.REPEATABLE_READ
            : IsolationLevel.READ_COMMITTED,
        readOnly: options.readOnly ?? false,
      });
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
