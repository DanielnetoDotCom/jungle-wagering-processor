import type { SqlEntityManager } from '@mikro-orm/postgresql';
import type {
  LedgerPageQuery,
  LedgerRepository,
  LedgerSummary,
} from '../../../application/ports/persistence.ports';
import type { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { Money } from '../../../domain/money/money';
import { ledgerEntryData, toLedgerEntry } from './mappers';
import { LedgerEntryRecord } from './records';
import { isUuid, sql } from './sql';

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: SqlEntityManager) {}

  /** Insert only: the repository has no update/delete path (and the database forbids both). */
  append(entry: WalletLedgerEntry): void {
    this.em.persist(this.em.create(LedgerEntryRecord, ledgerEntryData(entry)));
  }

  /** Keyset pagination served by the unique index (wallet_id, wallet_version). */
  async page(query: LedgerPageQuery): Promise<WalletLedgerEntry[]> {
    if (!isUuid(query.walletId)) return [];
    const bound =
      query.afterVersion === undefined
        ? {}
        : {
            walletVersion: query.order === 'asc' ? { $gt: query.afterVersion } : { $lt: query.afterVersion },
          };
    const records = await this.em.find(
      LedgerEntryRecord,
      { walletId: query.walletId, ...bound },
      { orderBy: { walletVersion: query.order }, limit: query.limit },
    );
    return records.map(toLedgerEntry);
  }

  /**
   * Σ(credits) − Σ(debits) with exact NUMERIC arithmetic in PostgreSQL, plus a
   * chain check: each entry must start where the previous one ended and
   * versions must be contiguous.
   */
  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const result = await sql<{
      entries: number;
      signed_total: string;
      last_version: number | null;
      chain_breaks: number;
    }>(
      this.em,
      `SELECT count(*)::int AS entries,
              coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(38, 2)::text AS signed_total,
              max(wallet_version) AS last_version,
              count(*) FILTER (
                WHERE (previous_after IS NULL AND balance_before <> 0)
                   OR (previous_after IS NOT NULL AND (balance_before <> previous_after OR wallet_version <> previous_version + 1))
              )::int AS chain_breaks
         FROM (
           SELECT direction, amount, balance_before, wallet_version,
                  lag(balance_after) OVER (ORDER BY wallet_version) AS previous_after,
                  lag(wallet_version) OVER (ORDER BY wallet_version) AS previous_version
             FROM wallet_ledger_entries
            WHERE wallet_id = ?
         ) chained`,
      [walletId],
    );
    const row = result.rows[0];
    return {
      entries: row?.entries ?? 0,
      signedTotal: Money.fromSigned({ amount: row?.signed_total ?? '0.00', currency }),
      lastVersion: row?.last_version ?? undefined,
      chainBreaks: row?.chain_breaks ?? 0,
    };
  }
}
