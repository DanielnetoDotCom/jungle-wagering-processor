import type { MoneyProps } from '../../domain/money/money';
import { ResourceNotFoundError } from '../errors/application-errors';
import type { WageringMetrics } from '../ports/metrics.port';
import type { UnitOfWork } from '../ports/persistence.ports';
import type { Clock, Logger } from '../ports/runtime.ports';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  /** storedBalance − calculatedBalance (exact decimal; may be negative). */
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  walletVersion: number;
  lastLedgerVersion: number | null;
  checks: {
    balanceMatches: boolean;
    /** wallet.version equals the version of the last ledger line (or 1 when there is none). */
    versionMatches: boolean;
    /** every line starts where the previous one ended and versions have no gaps. */
    chainIntact: boolean;
  };
  checkedAt: string;
}

/**
 * Rebuilds the balance from the immutable ledger and compares it with the
 * materialized balance. Runs in a REPEATABLE READ, READ ONLY transaction so
 * the wallet row and the ledger are read from the same snapshot: concurrent
 * movements can never produce a false divergence. Divergences are logged and
 * counted, never corrected automatically.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.uow.run(
      async (scope) => {
        const wallet = await scope.wallets.findById(walletId);
        if (!wallet) {
          throw new ResourceNotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
        }
        const summary = await scope.ledger.summarize(wallet.id, wallet.currency);
        const difference = wallet.balance.subtract(summary.signedTotal);
        const balanceMatches = difference.isZero();
        const versionMatches =
          summary.lastVersion === undefined ? wallet.version === 1 : summary.lastVersion === wallet.version;
        const chainIntact = summary.chainBreaks === 0;
        return {
          walletId: wallet.id,
          storedBalance: wallet.balance.toJSON(),
          calculatedBalance: summary.signedTotal.toJSON(),
          difference: difference.toJSON(),
          consistent: balanceMatches && versionMatches && chainIntact,
          checkedEntries: summary.entries,
          walletVersion: wallet.version,
          lastLedgerVersion: summary.lastVersion ?? null,
          checks: { balanceMatches, versionMatches, chainIntact },
          checkedAt: this.clock.now().toISOString(),
        } satisfies ReconciliationReport;
      },
      { isolation: 'repeatable read', readOnly: true },
    );

    this.metrics.reconciliationChecked(report.consistent);
    if (report.consistent) {
      this.logger.info('Wallet reconciled', { walletId, checkedEntries: report.checkedEntries });
    } else {
      this.logger.error('Wallet reconciliation found a divergence', {
        walletId,
        checkedEntries: report.checkedEntries,
        walletVersion: report.walletVersion,
        lastLedgerVersion: report.lastLedgerVersion,
        checks: report.checks,
        alert: 'RECONCILIATION_DIVERGENCE',
      });
    }
    return report;
  }
}
