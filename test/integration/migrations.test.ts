import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MIGRATIONS } from '../../migrations';
import { TestDatabase } from '../support/database';
import { createTestCore } from '../support/core';
import { httpCommand, payload, uniqueId } from '../support/fixtures';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
];

describe('Versioned, reversible migrations on a real PostgreSQL', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await TestDatabase.create('migrations');
  });

  afterAll(async () => {
    await db.drop();
  });

  async function tables(): Promise<string[]> {
    const rows = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name`,
      [TABLES],
    );
    return rows.map((row) => row.table_name);
  }

  async function executed(): Promise<string[]> {
    const rows = await db.query<{ name: string }>('SELECT name FROM mikro_orm_migrations ORDER BY id');
    return rows.map((row) => row.name);
  }

  test('up applies every migration in order', async () => {
    expect(await executed()).toEqual(MIGRATIONS.map((migration) => migration.name));
    expect(await tables()).toEqual([...TABLES].sort());
  });

  test('integrity triggers and least-privilege grants are in place', async () => {
    const triggers = await db.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`,
    );
    expect(triggers.map((row) => row.tgname)).toEqual(
      expect.arrayContaining([
        'wallet_ledger_entries_append_only',
        'wallet_ledger_entries_no_truncate',
        'wallet_ledger_entries_validate',
        'wallets_guard',
        'wallets_balance_change_has_ledger_entry',
        'wager_transactions_guard',
        'wager_transactions_validate_reference',
        'wager_transactions_processed_has_ledger_entry',
        'inbox_messages_guard',
        'outbox_messages_guard',
      ]),
    );
    const privileges = await db.one<Record<string, boolean>>(
      `SELECT has_table_privilege('wagering_app', 'wallet_ledger_entries', 'INSERT') AS ledger_insert,
              has_table_privilege('wagering_app', 'wallet_ledger_entries', 'UPDATE') AS ledger_update,
              has_table_privilege('wagering_app', 'wallet_ledger_entries', 'DELETE') AS ledger_delete,
              has_table_privilege('wagering_app', 'wager_transactions', 'DELETE') AS tx_delete,
              has_table_privilege('wagering_app', 'wallets', 'TRUNCATE') AS wallets_truncate,
              has_table_privilege('wagering_app', 'wallets', 'UPDATE') AS wallets_update`,
    );
    expect(privileges).toEqual({
      ledger_insert: true,
      ledger_update: false,
      ledger_delete: false,
      tx_delete: false,
      wallets_truncate: false,
      wallets_update: true,
    });
  });

  test('down reverts one step; down --all removes the whole schema; up rebuilds it', async () => {
    const reverted = await TestDatabase.migrate(db.name, 'down');
    expect(reverted).toEqual(['Migration20261022000500FinancialIntegrity']);
    expect(await executed()).toHaveLength(MIGRATIONS.length - 1);
    expect(await TestDatabase.migrate(db.name, 'down')).toEqual(['Migration20261022000400ApplicationRole']);
    const revoked = await db.one<{ ledger_insert: boolean }>(
      `SELECT has_table_privilege('wagering_app', 'wallet_ledger_entries', 'INSERT') AS ledger_insert`,
    );
    expect(revoked.ledger_insert).toBe(false);

    await TestDatabase.migrate(db.name, 'down', 0);
    expect(await tables()).toEqual([]);
    expect(await executed()).toEqual([]);
    const functions = await db.query(
      `SELECT proname FROM pg_proc WHERE proname LIKE 'wallet%' OR proname LIKE 'wager%'`,
    );
    expect(functions).toEqual([]);

    await TestDatabase.migrate(db.name, 'up');
    expect(await tables()).toEqual([...TABLES].sort());
    expect(await executed()).toHaveLength(MIGRATIONS.length);
  });

  test('running up again is a no-op', async () => {
    expect(await TestDatabase.migrate(db.name, 'up')).toEqual([]);
  });

  test('financial integrity upgrade and rollback preserve populated wallets and ledger history', async () => {
    await TestDatabase.migrate(db.name, 'down');
    const core = await createTestCore(db);
    try {
      for (const amount of ['0.00', '100.00']) {
        const wallet = await core.createWallet.execute({
          playerId: uniqueId('upgrade'),
          initialBalance: { amount, currency: 'BRL' },
          correlationId: 'c',
        });
        await core.processWager.execute(
          httpCommand(
            payload({ walletId: wallet.id, playerId: wallet.playerId, kind: 'WIN', amount: '20.00' }),
          ),
        );
      }
    } finally {
      await core.close();
    }
    const before = await db.query('SELECT * FROM wallet_ledger_entries ORDER BY id');
    expect(before).toHaveLength(3);
    await TestDatabase.migrate(db.name, 'up');
    expect(await db.query('SELECT * FROM wallet_ledger_entries ORDER BY id')).toEqual(before);
    await TestDatabase.migrate(db.name, 'down');
    expect(await db.query('SELECT * FROM wallet_ledger_entries ORDER BY id')).toEqual(before);
    await TestDatabase.migrate(db.name, 'up');
    expect(await db.query('SELECT * FROM wallet_ledger_entries ORDER BY id')).toEqual(before);
  });

  test('upgrade refuses old divergent history atomically without repairing or deleting it', async () => {
    const corrupt = await TestDatabase.create('legacy_corrupt');
    try {
      await TestDatabase.migrate(corrupt.name, 'down');
      const core = await createTestCore(corrupt);
      let wallet: { id: string; playerId: string };
      try {
        wallet = await core.createWallet.execute({
          playerId: uniqueId('legacy'),
          initialBalance: { amount: '0.00', currency: 'BRL' },
          correlationId: 'c',
        });
        await core.processWager.execute(
          httpCommand(
            payload({ walletId: wallet.id, playerId: wallet.playerId, kind: 'WIN', amount: '20.00' }),
          ),
        );
      } finally {
        await core.close();
      }
      const app = await corrupt.appClient();
      try {
        await app.query('BEGIN');
        const tx = await app.query<{ id: string }>(
          `INSERT INTO wager_transactions
          (id,provider_id,external_transaction_id,idempotency_key,payload_hash,channel,wallet_id,player_id,round_id,game_id,
           kind,amount,currency,status,result_balance_amount,result_wallet_version,created_at,updated_at,processed_at)
          VALUES (gen_random_uuid(),'legacy','backfill','backfill',repeat('a',64),'HTTP',$1,$2,'r','g',
                  'WIN',10,'BRL','PROCESSED',10,1,now(),now(),now()) RETURNING id`,
          [wallet.id, wallet.playerId],
        );
        await app.query(
          `INSERT INTO wallet_ledger_entries VALUES
          (gen_random_uuid(),$1,$2,'CREDIT',10,'BRL',0,10,1,now())`,
          [wallet.id, tx.rows[0]!.id],
        );
        await app.query('COMMIT'); // Reproduces the vulnerability on the old schema only.
      } finally {
        await app.end();
      }
      const history = await corrupt.query('SELECT * FROM wallet_ledger_entries ORDER BY id');
      await expect(TestDatabase.migrate(corrupt.name, 'up')).rejects.toThrow();
      expect(await corrupt.query('SELECT * FROM wallet_ledger_entries ORDER BY id')).toEqual(history);
      expect(await corrupt.one('SELECT count(*)::int AS count FROM mikro_orm_migrations')).toEqual({
        count: 4,
      });
      expect(
        await corrupt.one(
          `SELECT count(*)::int AS count FROM pg_constraint WHERE conname='wallets_balance_finite_ck'`,
        ),
      ).toEqual({ count: 0 });
    } finally {
      await corrupt.drop();
    }
  });
});
