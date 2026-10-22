import { ResourceNotFoundError } from '../errors/application-errors';
import type { UnitOfWork } from '../ports/persistence.ports';
import {
  toLedgerEntryView,
  toTransactionView,
  toWalletView,
  type LedgerEntryView,
  type WagerTransactionView,
  type WalletView,
} from '../views';

export interface LedgerPage {
  walletId: string;
  items: LedgerEntryView[];
  /** Keyset cursor value (last wallet_version of this page); null when there is no next page. */
  nextAfterVersion: number | null;
}

/** Read-only queries; each runs in its own READ ONLY transaction. */
export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run((scope) => scope.wallets.findById(walletId), { readOnly: true });
    if (!wallet) {
      throw new ResourceNotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
    }
    return toWalletView(wallet);
  }

  /**
   * Keyset pagination on (wallet_id, wallet_version): stable under concurrent
   * inserts and O(limit) regardless of depth, unlike OFFSET.
   */
  async getLedgerPage(params: {
    walletId: string;
    afterVersion: number | undefined;
    limit: number;
    order: 'asc' | 'desc';
  }): Promise<LedgerPage> {
    return this.uow.run(
      async (scope) => {
        const wallet = await scope.wallets.findById(params.walletId);
        if (!wallet) {
          throw new ResourceNotFoundError('WALLET_NOT_FOUND', `Wallet ${params.walletId} not found`);
        }
        const entries = await scope.ledger.page({ ...params, limit: params.limit + 1 });
        const hasMore = entries.length > params.limit;
        const items = entries.slice(0, params.limit);
        const last = items.at(-1);
        return {
          walletId: wallet.id,
          items: items.map(toLedgerEntryView),
          nextAfterVersion: hasMore && last ? last.walletVersion : null,
        };
      },
      { readOnly: true },
    );
  }

  async getTransaction(transactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.uow.run((scope) => scope.transactions.findById(transactionId), {
      readOnly: true,
    });
    if (!transaction) {
      throw new ResourceNotFoundError('TRANSACTION_NOT_FOUND', `Transaction ${transactionId} not found`);
    }
    return toTransactionView(transaction);
  }

  async getTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const transaction = await this.uow.run(
      (scope) => scope.transactions.findByExternalId(providerId, externalTransactionId),
      { readOnly: true },
    );
    if (!transaction) {
      throw new ResourceNotFoundError(
        'TRANSACTION_NOT_FOUND',
        `Transaction ${externalTransactionId} of provider ${providerId} not found`,
      );
    }
    return toTransactionView(transaction);
  }
}
