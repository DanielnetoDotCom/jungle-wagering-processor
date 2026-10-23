import { expect } from 'bun:test';
import type { TestDatabase } from './database';

export interface WalletAudit {
  walletId: string;
  balance: string;
  version: number;
  ledgerTotal: string;
  entries: number;
  lastVersion: number | null;
  chainBreaks: number;
  /** Lines whose timestamp is earlier than the previous version's (audit order). */
  timeOrderBreaks: number;
}

/**
 * The invariant every suite ends with:
 *   wallet.balance == balance rebuilt from the ledger
 * plus version/chain integrity, computed independently of the application
 * code (plain SQL, exact NUMERIC arithmetic).
 */
export async function auditWallet(db: TestDatabase, walletId: string): Promise<WalletAudit> {
  const row = await db.one<{
    balance: string;
    version: number;
    ledger_total: string;
    entries: number;
    last_version: number | null;
    chain_breaks: number;
    time_order_breaks: number;
  }>(
    `SELECT w.balance_amount::text AS balance,
            w.version,
            coalesce(sum(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(38,2)::text AS ledger_total,
            count(l.id)::int AS entries,
            max(l.wallet_version) AS last_version,
            count(*) FILTER (
              WHERE l.id IS NOT NULL AND (
                (l.prev_after IS NULL AND l.balance_before <> 0)
                OR (l.prev_after IS NOT NULL AND (l.balance_before <> l.prev_after OR l.wallet_version <> l.prev_version + 1))
              )
            )::int AS chain_breaks,
            count(*) FILTER (WHERE l.created_at < l.prev_created_at)::int AS time_order_breaks
       FROM wallets w
       LEFT JOIN (
         SELECT *, lag(balance_after) OVER (PARTITION BY wallet_id ORDER BY wallet_version) AS prev_after,
                   lag(wallet_version) OVER (PARTITION BY wallet_id ORDER BY wallet_version) AS prev_version,
                   lag(created_at) OVER (PARTITION BY wallet_id ORDER BY wallet_version) AS prev_created_at
           FROM wallet_ledger_entries
       ) l ON l.wallet_id = w.id
      WHERE w.id = $1
      GROUP BY w.id`,
    [walletId],
  );
  return {
    walletId,
    balance: row.balance,
    version: row.version,
    ledgerTotal: row.ledger_total,
    entries: row.entries,
    lastVersion: row.last_version,
    chainBreaks: row.chain_breaks,
    timeOrderBreaks: row.time_order_breaks,
  };
}

export async function expectWalletConsistent(db: TestDatabase, walletId: string): Promise<WalletAudit> {
  const audit = await auditWallet(db, walletId);
  expect(audit.ledgerTotal).toBe(audit.balance);
  expect(audit.chainBreaks).toBe(0);
  expect(audit.timeOrderBreaks).toBe(0);
  expect(audit.version).toBe(audit.lastVersion ?? 1);
  return audit;
}

/**
 * Final check of a suite: every wallet of the database is consistent, except
 * those a test corrupted on purpose (they must be listed explicitly).
 */
export async function expectAllWalletsConsistent(
  db: TestDatabase,
  options: { except?: ReadonlySet<string> } = {},
): Promise<number> {
  const wallets = (await db.query<{ id: string }>('SELECT id FROM wallets')).filter(
    (wallet) => !options.except?.has(wallet.id),
  );
  for (const wallet of wallets) {
    await expectWalletConsistent(db, wallet.id);
  }
  const negative = await db.one<{ count: number }>(
    'SELECT count(*)::int AS count FROM wallets WHERE balance_amount < 0',
  );
  expect(negative.count).toBe(0);
  return wallets.length;
}
