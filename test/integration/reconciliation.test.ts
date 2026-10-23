import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ResourceNotFoundError } from '../../src/application/errors/application-errors';
import type { Core } from '../../src/bootstrap/core';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-types';
import { expectAllWalletsConsistent } from '../support/consistency';
import { createTestCore } from '../support/core';
import { TestDatabase } from '../support/database';
import { httpCommand, payload, uniqueId } from '../support/fixtures';

describe('Reconciliation: materialized balance vs immutable ledger', () => {
  let db: TestDatabase;
  let core: Core;
  /** Wallets corrupted on purpose; every other wallet must stay consistent. */
  const tampered = new Set<string>();

  beforeAll(async () => {
    db = await TestDatabase.create('reconciliation');
    core = await createTestCore(db);
  });

  afterAll(async () => {
    expect(tampered.size).toBeGreaterThan(0);
    expect(await expectAllWalletsConsistent(db, { except: tampered })).toBeGreaterThan(0);
    await core.close();
    await db.drop();
  });

  async function walletWithHistory(): Promise<{ walletId: string; playerId: string }> {
    const playerId = uniqueId('player');
    const walletId = (
      await core.createWallet.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
        correlationId: 'c',
      })
    ).id;
    const submit = (kind: Kind, amount: string, external: string, reference?: string) =>
      core.processWager.execute(
        httpCommand(
          payload({ walletId, playerId, kind, amount, externalTransactionId: external, reference }),
        ),
      );
    await submit(Kind.Bet, '33.33', `${walletId}-bet`);
    await submit(Kind.Win, '10.01', `${walletId}-win`, `${walletId}-bet`);
    await submit(Kind.Loss, '0.00', `${walletId}-loss`, `${walletId}-bet`);
    await submit(Kind.Bet, '500.00', `${walletId}-rejected`);
    return { walletId, playerId };
  }

  /** Simulates corruption that bypasses every trigger (only possible for a superuser). */
  async function tamper(sql: string, params: [walletId: string, ...rest: unknown[]]): Promise<void> {
    tampered.add(params[0]);
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL session_replication_role = replica`);
      await client.query(sql, params);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }

  test('a healthy wallet is consistent; exact decimal totals; entries counted', async () => {
    const { walletId } = await walletWithHistory();
    const report = await core.reconcileWallet.execute(walletId);
    expect(report).toMatchObject({
      walletId,
      storedBalance: { amount: '76.68', currency: 'BRL' },
      calculatedBalance: { amount: '76.68', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3, // OPENING + BET + WIN (LOSS and the REJECTED bet move nothing)
      walletVersion: 3,
      lastLedgerVersion: 3,
      checks: { balanceMatches: true, versionMatches: true, chainIntact: true },
    });
  });

  test('a divergent balance is reported (exact difference), logged and counted - never auto-corrected', async () => {
    const { walletId } = await walletWithHistory();
    await tamper(`UPDATE wallets SET balance_amount = balance_amount + 0.01 WHERE id = $1`, [walletId]);

    const report = await core.reconcileWallet.execute(walletId);
    expect(report.consistent).toBe(false);
    expect(report.difference).toEqual({ amount: '0.01', currency: 'BRL' });
    expect(report.checks.balanceMatches).toBe(false);
    const metrics = await core.metrics.render();
    expect(metrics).toMatch(/wagering_reconciliation_inconsistencies_total\{[^}]*\} 1/);

    const stored = await db.one<{ balance_amount: string }>(
      `SELECT balance_amount FROM wallets WHERE id = $1`,
      [walletId],
    );
    expect(stored.balance_amount).toBe('76.69'); // still the divergent value: nothing was "fixed"
  });

  test('a broken ledger chain is detected even when the totals still match', async () => {
    const { walletId } = await walletWithHistory();
    // Shift money between two lines: totals unchanged, chain broken.
    await tamper(
      `UPDATE wallet_ledger_entries SET balance_before = balance_before + 1, balance_after = balance_after + 1
        WHERE wallet_id = $1 AND wallet_version = 2`,
      [walletId],
    );
    const report = await core.reconcileWallet.execute(walletId);
    expect(report.checks).toEqual({ balanceMatches: true, versionMatches: true, chainIntact: false });
    expect(report.consistent).toBe(false);
  });

  test('concurrent movements never produce a false divergence (single REPEATABLE READ snapshot)', async () => {
    const playerId = uniqueId('player');
    const walletId = (
      await core.createWallet.execute({
        playerId,
        initialBalance: { amount: '1000.00', currency: 'BRL' },
        correlationId: 'c',
      })
    ).id;
    const writes = Array.from({ length: 40 }, (_, index) =>
      core.processWager.execute(
        httpCommand(payload({ walletId, playerId, kind: index % 2 ? Kind.Win : Kind.Bet, amount: '1.25' })),
      ),
    );
    const reads = Array.from({ length: 40 }, () => core.reconcileWallet.execute(walletId));
    const [, reports] = await Promise.all([Promise.all(writes), Promise.all(reads)]);
    expect(reports.every((report) => report.consistent)).toBe(true);
  });

  test('unknown wallet -> WALLET_NOT_FOUND', async () => {
    await expect(core.reconcileWallet.execute('00000000-0000-7000-8000-000000000000')).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });
});
