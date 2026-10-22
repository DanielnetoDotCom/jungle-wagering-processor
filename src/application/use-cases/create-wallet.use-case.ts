import { WalletBalanceChanged, WagerTransactionProcessed } from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { TransactionChannel, WagerTransactionKind } from '../../domain/wagering/wager-transaction-types';
import { Wallet } from '../../domain/wallet/wallet';
import { canonicalJson } from '../../shared/canonical-json';
import type { CreateWalletCommand } from '../commands/wager-commands';
import {
  ConflictError,
  RequestValidationError,
  UniqueConstraintRaceError,
} from '../errors/application-errors';
import type { WageringMetrics } from '../ports/metrics.port';
import type { UnitOfWork } from '../ports/persistence.ports';
import type { Clock, IdGenerator, Logger } from '../ports/runtime.ports';
import { sha256Hex } from '../services/payload-hash';
import { toWalletView, type WalletView } from '../views';

/** Provider id used for internal (system-generated) transactions such as OPENING. */
export const INTERNAL_PROVIDER_ID = 'internal';

/**
 * Opens a wallet. A positive initial balance is a financial movement, so it
 * creates, in the SAME SQL transaction: the wallet (version 1), an internal
 * OPENING transaction, its CREDIT ledger line (0 -> initial, version 1) and
 * the outbox events. A zero balance creates no artificial ledger line.
 */
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
    private readonly acceptedCurrencies: ReadonlySet<string>,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    if (!this.acceptedCurrencies.has(initialBalance.currency)) {
      throw new RequestValidationError('Currency not accepted by this deployment', [
        { path: 'initialBalance.currency', message: `Accepted: ${[...this.acceptedCurrencies].join(', ')}` },
      ]);
    }

    try {
      const wallet = await this.uow.run(async (scope) => {
        const existing = await scope.wallets.findByPlayerAndCurrency(
          command.playerId,
          initialBalance.currency,
        );
        if (existing) {
          throw this.alreadyExists(existing.id);
        }
        const now = this.clock.now();
        const walletId = this.ids.next();
        const openingTransactionId = this.ids.next();
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance,
          openedAt: now,
          opening: { transactionId: openingTransactionId, ledgerEntryId: this.ids.next() },
        });
        scope.wallets.save(wallet);

        if (openingEntry) {
          const opening = WagerTransaction.create({
            id: openingTransactionId,
            providerId: INTERNAL_PROVIDER_ID,
            externalTransactionId: `wallet-opening:${walletId}`,
            idempotencyKey: `wallet-opening:${walletId}`,
            payloadHash: sha256Hex(
              canonicalJson({
                walletId,
                initialBalance: { amount: initialBalance.amount, currency: initialBalance.currency },
              }),
            ),
            channel: TransactionChannel.Internal,
            walletId,
            playerId: command.playerId,
            roundId: undefined,
            gameId: undefined,
            kind: WagerTransactionKind.Opening,
            money: initialBalance,
            referenceExternalTransactionId: undefined,
            createdAt: now,
          });
          opening.markProcessed({ referenceTransactionId: undefined, at: now, result: wallet.snapshot() });
          scope.transactions.save(opening);
          scope.ledger.append(openingEntry);

          const context = { correlationId: command.correlationId, occurredAt: now };
          scope.outbox.add(
            OutboxMessage.enqueue(
              WagerTransactionProcessed.from(opening, { ...context, eventId: this.ids.next() }),
              'WagerTransaction',
            ),
          );
          scope.outbox.add(
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, { ...context, eventId: this.ids.next() }),
              'Wallet',
            ),
          );
          this.metrics.transactionRecorded(opening.kind, opening.status, opening.channel);
        }
        return wallet;
      });

      this.logger.info('Wallet opened', { walletId: wallet.id, currency: wallet.currency });
      return toWalletView(wallet);
    } catch (error) {
      // Two concurrent creations for the same player+currency: the unique constraint decides.
      if (error instanceof UniqueConstraintRaceError && error.constraint === 'wallets_player_currency_uq') {
        const existing = await this.uow.run((scope) =>
          scope.wallets.findByPlayerAndCurrency(command.playerId, initialBalance.currency),
        );
        throw this.alreadyExists(existing?.id);
      }
      throw error;
    }
  }

  private alreadyExists(walletId: string | undefined): ConflictError {
    return new ConflictError(
      'WALLET_ALREADY_EXISTS',
      'A wallet already exists for this player and currency',
      walletId ? { walletId } : undefined,
    );
  }
}
