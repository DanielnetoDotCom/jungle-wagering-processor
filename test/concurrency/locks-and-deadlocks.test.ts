import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TransientInfrastructureError } from '../../src/application/errors/application-errors';
import type { Core } from '../../src/bootstrap/core';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-types';
import { expectAllWalletsConsistent, expectWalletConsistent } from '../support/consistency';
import { createTestCore } from '../support/core';
import { TestDatabase } from '../support/database';
import { httpCommand, Latch, payload, ScriptedFaults, uniqueId } from '../support/fixtures';

describe('Row locks, lock timeouts and deadlocks (controlled)', () => {
  let db: TestDatabase;
  let core: Core;
  const faults = new ScriptedFaults();

  beforeAll(async () => {
    db = await TestDatabase.create('locks');
    core = await createTestCore(db, {
      overrides: { faults },
      env: { DB_LOCK_TIMEOUT_MS: '500', TX_RETRY_MAX_ATTEMPTS: '3', TX_RETRY_BASE_MS: '50' },
    });
  });

  afterAll(async () => {
    await expectAllWalletsConsistent(db);
    await core.close();
    await db.drop();
  });

  async function openWallet(amount = '100.00') {
    const playerId = uniqueId('player');
    const walletId = (
      await core.createWallet.execute({
        playerId,
        initialBalance: { amount, currency: 'BRL' },
        correlationId: 'c',
      })
    ).id;
    return { walletId, playerId };
  }

  async function lineCount(walletId: string): Promise<number> {
    return (
      await db.one<{ count: number }>(
        `SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1`,
        [walletId],
      )
    ).count;
  }

  test('a wallet held by another transaction makes writers wait (contention is measured), then they proceed', async () => {
    const { walletId, playerId } = await openWallet();
    const holder = await db.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
      const pending = core.processWager.execute(
        httpCommand(payload({ walletId, playerId, kind: Kind.Bet, amount: '5.00' })),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await holder.query('COMMIT');
      expect((await pending).type).toBe('RECORDED');
    } finally {
      holder.release();
    }
    expect(await core.metrics.render()).toMatch(/wagering_wallet_lock_contention_total\{[^}]*\} [1-9]/);
  });

  test('lock_timeout: bounded wait, retried, then a retryable LOCK_TIMEOUT error with nothing persisted', async () => {
    const { walletId, playerId } = await openWallet();
    const holder = await db.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
      const error = await core.processWager
        .execute(httpCommand(payload({ walletId, playerId, kind: Kind.Bet, amount: '5.00' })))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TransientInfrastructureError);
      expect((error as TransientInfrastructureError).code).toBe('LOCK_TIMEOUT');
      expect((error as TransientInfrastructureError).retryable).toBe(true);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await lineCount(walletId)).toBe(1);
    const metrics = await core.metrics.render();
    expect(metrics).toMatch(/wagering_lock_timeouts_total\{[^}]*\} [1-9]/);
    expect(metrics).toMatch(/wagering_db_retries_total\{[^}]*reason="lock_timeout"[^}]*\} [1-9]/);
  });

  test('a provoked deadlock is detected by PostgreSQL, retried from scratch and applied exactly once', async () => {
    // lock_timeout must exceed deadlock_timeout (1s), otherwise the wait below ends as a
    // lock timeout (also transient and retried) before PostgreSQL reports the deadlock.
    const deadlockCore = await createTestCore(db, {
      overrides: { faults },
      env: { DB_LOCK_TIMEOUT_MS: '5000', TX_RETRY_MAX_ATTEMPTS: '3', TX_RETRY_BASE_MS: '50' },
    });
    try {
      await provokeDeadlock(deadlockCore);
    } finally {
      await deadlockCore.close();
    }
  });

  async function provokeDeadlock(core: Core): Promise<void> {
    const { walletId, playerId } = await openWallet();
    const command = httpCommand(payload({ walletId, playerId, kind: Kind.Bet, amount: '10.00' }));

    // Interfering session T1 takes the idempotency key first (uncommitted unique entry) and
    // waits long before checking deadlocks, so OUR transaction is the deadlock victim.
    const t1 = await db.admin.connect();
    const latch = new Latch();
    let paused = false;
    faults.on('wager.before-flush', async () => {
      if (!paused) {
        paused = true;
        await latch.wait();
      }
    });
    try {
      await t1.query('BEGIN');
      await t1.query(`SET LOCAL deadlock_timeout = '10s'`);
      await t1.query(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, channel, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, status, failure_code, result_balance_amount, result_wallet_version, created_at, updated_at, processed_at)
         VALUES (gen_random_uuid(), 'provider-a', 'interloper', $1, repeat('f', 64), 'HTTP', $2, $3, 'r', 'g', 'BET', 1.00, 'BRL',
                 'REJECTED', 'TEST', 0, 1, now(), now(), now())`,
        [command.idempotencyKey, walletId, playerId],
      );

      // Our transaction locks the wallet, then pauses right before inserting its rows.
      const ours = core.processWager.execute(command);
      await latch.reached;
      // T1 now wants the wallet (held by us) ...
      const t1WantsWallet = t1.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      // ... and we insert the same idempotency key (held by T1): a cycle.
      latch.open();

      // PostgreSQL aborts our transaction (deadlock_timeout 1s < 10s); T1 gets the wallet. T1 then rolls back.
      await t1WantsWallet;
      await t1.query('ROLLBACK');
      const result = await ours;
      expect(result.type).toBe('RECORDED');
    } finally {
      faults.clear();
      t1.release();
    }
    expect(await lineCount(walletId)).toBe(2);
    expect((await expectWalletConsistent(db, walletId)).balance).toBe('90.00');
    const metrics = await core.metrics.render();
    expect(metrics).toMatch(/wagering_deadlocks_total\{[^}]*\} 1/);
    expect(metrics).toMatch(/wagering_db_retries_total\{[^}]*reason="deadlock"[^}]*\} 1/);
  }

  test('different wallets never block each other (no global lock)', async () => {
    const a = await openWallet();
    const b = await openWallet();
    const holder = await db.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [a.walletId]);
      const startedAt = performance.now();
      const result = await core.processWager.execute(
        httpCommand(payload({ ...b, kind: Kind.Bet, amount: '1.00' })),
      );
      expect(result.type).toBe('RECORDED');
      expect(performance.now() - startedAt).toBeLessThan(400); // well below the 500ms lock_timeout
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
});
