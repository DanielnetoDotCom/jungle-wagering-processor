import { LockMode } from '@mikro-orm/core';
import type { SqlEntityManager } from '@mikro-orm/postgresql';
import type { WalletLockResult, WalletRepository } from '../../../application/ports/persistence.ports';
import type { Wallet } from '../../../domain/wallet/wallet';
import { toWallet, walletData } from './mappers';
import { WalletRecord } from './records';
import { isUuid } from './sql';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    if (!isUuid(id)) return undefined;
    const record = await this.em.findOne(WalletRecord, { id });
    return record ? toWallet(record) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency });
    return record ? toWallet(record) : undefined;
  }

  /**
   * `SELECT ... FOR UPDATE` on one wallet row. A first `FOR UPDATE SKIP LOCKED`
   * probe tells whether the row is currently held by someone else, which
   * feeds the lock-contention metric at the cost of one extra query only
   * when there IS contention (or the wallet does not exist).
   */
  async lockById(id: string): Promise<WalletLockResult> {
    const startedAt = performance.now();
    if (!isUuid(id)) {
      return { wallet: undefined, contended: false, waitSeconds: 0 };
    }
    let record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, refresh: true },
    );
    let contended = false;
    if (!record) {
      // Blocks until the holder commits/rolls back, bounded by lock_timeout.
      record = await this.em.findOne(
        WalletRecord,
        { id },
        { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
      );
      contended = record !== null;
    }
    return {
      wallet: record ? toWallet(record) : undefined,
      contended,
      waitSeconds: (performance.now() - startedAt) / 1000,
    };
  }

  save(wallet: Wallet): void {
    const data = walletData(wallet);
    const managed = this.em.getUnitOfWork().getById<WalletRecord>(WalletRecord.name, wallet.id);
    if (managed) {
      this.em.assign(managed, data);
    } else {
      this.em.persist(this.em.create(WalletRecord, data));
    }
  }
}
