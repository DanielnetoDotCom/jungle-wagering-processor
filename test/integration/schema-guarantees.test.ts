import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { Core } from '../../src/bootstrap/core';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction-types';
import { expectAllWalletsConsistent } from '../support/consistency';
import { createTestCore } from '../support/core';
import { TestDatabase } from '../support/database';
import { httpCommand, payload, uniqueId } from '../support/fixtures';

/**
 * The application is NOT the last line of defence: these tests attack the
 * schema directly with SQL (as the owner and as the runtime login) and
 * expect PostgreSQL itself to refuse every invariant violation.
 */
describe('Schema guarantees enforced by PostgreSQL', () => {
  let db: TestDatabase;
  let core: Core;
  let walletId: string;
  let playerId: string;
  let betId: string;

  beforeAll(async () => {
    db = await TestDatabase.create('schema');
    core = await createTestCore(db);
    playerId = uniqueId('player');
    walletId = (
      await core.createWallet.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
        correlationId: 'c',
      })
    ).id;
    const result = await core.processWager.execute(
      httpCommand(
        payload({ walletId, playerId, kind: Kind.Bet, amount: '30.00', externalTransactionId: 'bet-1' }),
      ),
    );
    if (result.type !== 'RECORDED') throw new Error('setup failed');
    betId = result.transaction.transactionId;
  });

  afterAll(async () => {
    await expectAllWalletsConsistent(db);
    await core.close();
    await db.drop();
  });

  async function rejects(
    statement: Promise<unknown>,
    expected: { code?: string; constraint?: string },
  ): Promise<void> {
    let error: { code?: string; constraint?: string; message?: string } | undefined;
    try {
      await statement;
    } catch (caught) {
      error = caught as typeof error;
    }
    expect(error).toBeDefined();
    if (expected.code) expect(error?.code).toBe(expected.code);
    if (expected.constraint) expect(error?.constraint).toBe(expected.constraint);
  }

  /** Runs statements in one SQL transaction; the error is expected at COMMIT (deferred rules). */
  async function inTransaction(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  function insertTransaction(
    client: PoolClient | TestDatabase,
    row: {
      kind: string;
      amount: string;
      status: string;
      external?: string;
      reference?: string;
      referenceId?: string;
      failure?: string;
      channel?: string;
      provider?: string;
    },
  ): Promise<unknown> {
    const external = row.external ?? uniqueId('raw');
    const query = `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash, channel, wallet_id, player_id, round_id, game_id,
         kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code,
         result_balance_amount, result_wallet_version, created_at, updated_at, processed_at)
      VALUES (gen_random_uuid(), $11::varchar, $1::varchar, $1::varchar, repeat('a', 64), $2::varchar, $3::uuid, $4::varchar,
              'round-1', 'fortune-chimp', $5::varchar, $6::numeric, 'BRL', $7::varchar, $8::uuid, $9::varchar, $10::varchar,
              70.00, 2, now(), now(), CASE WHEN $9::varchar IN ('PROCESSED','REJECTED','FAILED') THEN now() END)
      RETURNING id`;
    const params = [
      external,
      row.channel ?? 'HTTP',
      walletId,
      playerId,
      row.kind,
      row.amount,
      row.reference ?? null,
      row.referenceId ?? null,
      row.status,
      row.failure ?? null,
      row.provider ?? 'provider-a',
    ];
    return client instanceof TestDatabase ? client.query(query, params) : client.query(query, params);
  }

  describe('wallets', () => {
    test('one wallet per player and currency', async () => {
      await rejects(
        db.query(`INSERT INTO wallets VALUES (gen_random_uuid(), $1, 'BRL', 0, 1, now(), now())`, [playerId]),
        { code: '23505', constraint: 'wallets_player_currency_uq' },
      );
    });

    test('balance can never be negative', async () => {
      await rejects(
        db.query(`UPDATE wallets SET balance_amount = -0.01, version = version + 1 WHERE id = $1`, [
          walletId,
        ]),
        { code: '23514', constraint: 'wallets_balance_non_negative_ck' },
      );
    });

    test('version changes iff the balance changes (+1)', async () => {
      await rejects(
        db.query(`UPDATE wallets SET balance_amount = balance_amount + 1 WHERE id = $1`, [walletId]),
        {
          constraint: 'wallets_version_follows_balance',
        },
      );
      await rejects(db.query(`UPDATE wallets SET version = version + 1 WHERE id = $1`, [walletId]), {
        constraint: 'wallets_version_follows_balance',
      });
      await rejects(
        db.query(`INSERT INTO wallets VALUES (gen_random_uuid(), 'p-v', 'BRL', 0, 7, now(), now())`),
        {
          constraint: 'wallets_initial_version',
        },
      );
    });

    test('a balance change without its ledger line is refused at COMMIT', async () => {
      await rejects(
        inTransaction(async (client) => {
          await client.query(
            `UPDATE wallets SET balance_amount = balance_amount + 10, version = version + 1 WHERE id = $1`,
            [walletId],
          );
        }),
        { code: '23514', constraint: 'wallets_balance_change_has_ledger_entry' },
      );
    });

    test('wallets cannot be deleted or truncated', async () => {
      await rejects(db.query(`DELETE FROM wallets WHERE id = $1`, [walletId]), {
        constraint: 'wallets_permanent',
      });
      await rejects(db.query(`TRUNCATE wallets CASCADE`), { constraint: 'wallets_permanent' });
    });
  });

  describe('ledger', () => {
    test('is append-only even for the schema owner', async () => {
      await rejects(
        db.query(`UPDATE wallet_ledger_entries SET amount = amount WHERE wallet_id = $1`, [walletId]),
        {
          code: '23000',
          constraint: 'wallet_ledger_entries_append_only',
        },
      );
      await rejects(db.query(`DELETE FROM wallet_ledger_entries WHERE wallet_id = $1`, [walletId]), {
        constraint: 'wallet_ledger_entries_append_only',
      });
      await rejects(db.query(`TRUNCATE wallet_ledger_entries`), {
        constraint: 'wallet_ledger_entries_append_only',
      });
    });

    test('the runtime login has no UPDATE/DELETE privilege on it at all', async () => {
      const app = await db.appClient();
      try {
        await rejects(app.query(`UPDATE wallet_ledger_entries SET amount = amount`), { code: '42501' });
        await rejects(app.query(`DELETE FROM wallet_ledger_entries`), { code: '42501' });
        await rejects(app.query(`DELETE FROM wager_transactions`), { code: '42501' });
        const rows = await app.query(`SELECT count(*)::int AS count FROM wallet_ledger_entries`);
        expect(rows.rows[0]?.count).toBeGreaterThan(0);
      } finally {
        await app.end();
      }
    });

    test('arithmetic must hold on every line', async () => {
      await rejects(
        db.query(
          `INSERT INTO wallet_ledger_entries VALUES (gen_random_uuid(), $1, $2, 'DEBIT', 10.00, 'BRL', 70.00, 61.00, 99, now())`,
          [walletId, betId],
        ),
        { code: '23514', constraint: 'ledger_arithmetic_ck' },
      );
    });

    test('one line per transaction', async () => {
      await rejects(
        db.query(
          `INSERT INTO wallet_ledger_entries VALUES (gen_random_uuid(), $1, $2, 'DEBIT', 30.00, 'BRL', 70.00, 40.00, 3, now())`,
          [walletId, betId],
        ),
        { code: '23505', constraint: 'ledger_transaction_uq' },
      );
    });

    test('lines must chain (balance_before = previous balance_after) and be backed by a balance change', async () => {
      await rejects(
        inTransaction(async (client) => {
          const inserted = await insertTransaction(client, {
            kind: 'BET',
            amount: '5.00',
            status: 'PROCESSED',
          });
          const id = (inserted as { rows: Array<{ id: string }> }).rows[0]?.id;
          // The wallet moves to what the line claims, so only the broken chain is wrong:
          // balance_before 71.00 does not continue the previous balance_after 70.00.
          await client.query(`UPDATE wallets SET balance_amount = 66.00, version = 3 WHERE id = $1`, [
            walletId,
          ]);
          await client.query(
            `INSERT INTO wallet_ledger_entries VALUES (gen_random_uuid(), $1, $2, 'DEBIT', 5.00, 'BRL', 71.00, 66.00, 3, now())`,
            [walletId, id],
          );
        }),
        { code: '23514', constraint: 'ledger_chain_continuity' },
      );
      await rejects(
        inTransaction(async (client) => {
          const inserted = await insertTransaction(client, {
            kind: 'BET',
            amount: '5.00',
            status: 'PROCESSED',
          });
          const id = (inserted as { rows: Array<{ id: string }> }).rows[0]?.id;
          // A chained line with no matching balance change on the wallet.
          await client.query(
            `INSERT INTO wallet_ledger_entries VALUES (gen_random_uuid(), $1, $2, 'DEBIT', 5.00, 'BRL', 70.00, 65.00, 3, now())`,
            [walletId, id],
          );
        }),
        { code: '23514', constraint: 'ledger_entry_has_balance_change' },
      );
    });

    test('a line must belong to a PROCESSED transaction, in the direction of its kind, with its exact amount', async () => {
      const lineFor = (
        kind: string,
        status: string,
        direction: string,
        txAmount: string,
        lineAmount: string,
        failure?: string,
      ) =>
        inTransaction(async (client) => {
          const inserted = await insertTransaction(client, { kind, amount: txAmount, status, failure });
          const id = (inserted as { rows: Array<{ id: string }> }).rows[0]?.id;
          // Exact NUMERIC arithmetic in PostgreSQL (never floats, even in tests).
          const after = `CASE WHEN $2::varchar = 'DEBIT' THEN 70.00 - $3::numeric ELSE 70.00 + $3::numeric END`;
          await client.query(
            `UPDATE wallets SET balance_amount = ${after}, version = 3 WHERE id = $1::uuid`,
            [walletId, direction, lineAmount],
          );
          await client.query(
            `INSERT INTO wallet_ledger_entries
             SELECT gen_random_uuid(), $1::uuid, $4::uuid, $2::varchar, $3::numeric, 'BRL', 70.00, ${after}, 3, now()`,
            [walletId, direction, lineAmount, id],
          );
        });

      await rejects(lineFor('BET', 'REJECTED', 'DEBIT', '5.00', '5.00', 'INSUFFICIENT_FUNDS'), {
        constraint: 'ledger_requires_processed_transaction',
      });
      await rejects(lineFor('BET', 'PROCESSED', 'CREDIT', '5.00', '5.00'), {
        constraint: 'ledger_direction_matches_kind',
      });
      await rejects(lineFor('LOSS', 'PROCESSED', 'DEBIT', '5.00', '5.00'), {
        constraint: 'ledger_direction_matches_kind',
      });
      await rejects(lineFor('BET', 'PROCESSED', 'DEBIT', '5.00', '4.00'), {
        code: '23503',
        constraint: 'ledger_transaction_fk',
      });
    });
  });

  describe('wager transactions', () => {
    test('a PROCESSED transaction that moves money must have its ledger line', async () => {
      await rejects(
        inTransaction(async (client) => {
          await insertTransaction(client, { kind: 'WIN', amount: '5.00', status: 'PROCESSED' });
        }),
        { code: '23514', constraint: 'wager_tx_processed_has_ledger_entry' },
      );
    });

    test('terminal transactions are immutable and permanent', async () => {
      await rejects(
        db.query(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = $1`, [
          betId,
        ]),
        {
          constraint: 'wager_tx_terminal_immutable',
        },
      );
      await rejects(db.query(`UPDATE wager_transactions SET claimed_by = NULL WHERE id = $1`, [betId]), {
        constraint: 'wager_tx_terminal_immutable',
      });
      await rejects(db.query(`DELETE FROM wager_transactions WHERE id = $1`, [betId]), {
        constraint: 'wager_tx_permanent',
      });
    });

    test('identity and financial content of a waiting transaction cannot change', async () => {
      const inserted = await insertTransaction(db, {
        kind: 'REFUND',
        amount: '9.00',
        status: 'PENDING_REFERENCE',
        reference: 'never',
      }).catch((error: unknown) => error);
      // PENDING_REFERENCE requires its schedule columns:
      expect((inserted as { constraint?: string }).constraint).toBe('wager_tx_pending_schedule_ck');
      const rows = await db.query<{ id: string }>(
        `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, channel, wallet_id, player_id, round_id, game_id,
            kind, amount, currency, reference_external_transaction_id, status, result_balance_amount, result_wallet_version,
            next_attempt_at, reference_expires_at, created_at, updated_at)
         VALUES (gen_random_uuid(), 'provider-a', 'pending-1', 'pending-1', repeat('a', 64), 'HTTP', $1, $2, 'round-1', 'g',
                 'REFUND', 9.00, 'BRL', 'never', 'PENDING_REFERENCE', 70.00, 2, now(), now() + interval '1 hour', now(), now())
         RETURNING id`,
        [walletId, playerId],
      );
      const pendingId = rows[0]?.id;
      await rejects(db.query(`UPDATE wager_transactions SET amount = 1000.00 WHERE id = $1`, [pendingId]), {
        constraint: 'wager_tx_identity_immutable',
      });
      await rejects(db.query(`UPDATE wager_transactions SET status = 'PENDING' WHERE id = $1`, [pendingId]), {
        constraint: 'wager_tx_status_transition',
      });
      await rejects(
        db.query(`UPDATE wager_transactions SET reference_attempts = -1 WHERE id = $1`, [pendingId]),
        { code: '23514', constraint: 'wager_tx_attempts_monotonic' },
      );
    });

    test('idempotency keys and external ids are unique per provider', async () => {
      await rejects(
        db.query(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, channel, wallet_id,
             player_id, round_id, game_id, kind, amount, currency, status, failure_code, result_balance_amount, result_wallet_version,
             created_at, updated_at, processed_at)
           SELECT gen_random_uuid(), provider_id, 'another-external', idempotency_key, payload_hash, channel, wallet_id, player_id,
                  round_id, game_id, kind, amount, currency, 'REJECTED', 'X', 0, 1, now(), now(), now()
             FROM wager_transactions WHERE id = $1`,
          [betId],
        ),
        { code: '23505', constraint: 'wager_tx_provider_idempotency_key_uq' },
      );
      await rejects(
        db.query(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, channel, wallet_id,
             player_id, round_id, game_id, kind, amount, currency, status, failure_code, result_balance_amount, result_wallet_version,
             created_at, updated_at, processed_at)
           SELECT gen_random_uuid(), provider_id, external_transaction_id, 'another-key', payload_hash, channel, wallet_id, player_id,
                  round_id, game_id, kind, amount, currency, 'REJECTED', 'X', 0, 1, now(), now(), now()
             FROM wager_transactions WHERE id = $1`,
          [betId],
        ),
        { code: '23505', constraint: 'wager_tx_provider_external_id_uq' },
      );
    });

    test('at most one successful reversal per referenced transaction (any reversal kind)', async () => {
      const refund = await core.processWager.execute(
        httpCommand(
          payload({
            walletId,
            playerId,
            kind: Kind.Refund,
            amount: '30.00',
            reference: 'bet-1',
            externalTransactionId: 'refund-1',
          }),
        ),
      );
      expect(refund.type === 'RECORDED' && refund.transaction.status).toBe(WagerTransactionStatus.Processed);
      await rejects(
        insertTransaction(db, {
          kind: 'ROLLBACK',
          amount: '30.00',
          status: 'PROCESSED',
          reference: 'bet-1',
          referenceId: betId,
        }),
        { code: '23505', constraint: 'wager_tx_single_successful_reversal_uq' },
      );
    });

    test('references are validated against the referenced row', async () => {
      const win = await core.processWager.execute(
        httpCommand(
          payload({ walletId, playerId, kind: Kind.Win, amount: '5.00', externalTransactionId: 'win-1' }),
        ),
      );
      const winId = win.type === 'RECORDED' ? win.transaction.transactionId : '';
      await rejects(
        insertTransaction(db, {
          kind: 'REFUND',
          amount: '5.00',
          status: 'PROCESSED',
          reference: 'win-1',
          referenceId: winId,
        }),
        {
          constraint: 'wager_tx_reference_kind',
        },
      );
      await rejects(
        insertTransaction(db, {
          kind: 'ROLLBACK',
          amount: '4.00',
          status: 'PROCESSED',
          reference: 'win-1',
          referenceId: winId,
        }),
        {
          constraint: 'wager_tx_reversal_amount',
        },
      );
    });

    test('OPENING is internal only', async () => {
      await rejects(
        insertTransaction(db, {
          kind: 'OPENING',
          amount: '5.00',
          status: 'REJECTED',
          failure: 'X',
          channel: 'HTTP',
        }),
        {
          constraint: 'wager_tx_opening_internal_ck',
        },
      );
    });

    test('the internal provider id is reserved to the internal channel', async () => {
      await rejects(
        insertTransaction(db, {
          kind: 'BET',
          amount: '5.00',
          status: 'REJECTED',
          failure: 'X',
          provider: 'internal',
        }),
        { constraint: 'wager_tx_internal_provider_ck' },
      );
      await rejects(
        insertTransaction(db, {
          kind: 'OPENING',
          amount: '5.00',
          status: 'REJECTED',
          failure: 'X',
          channel: 'INTERNAL',
        }),
        { constraint: 'wager_tx_internal_provider_ck' },
      );
    });
  });

  describe('messaging tables', () => {
    test('inbox: one row per (consumer, message); processed rows are immutable', async () => {
      await db.query(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, status, outcome, received_at, processed_at)
         VALUES ('c', 'm-1', repeat('b', 64), 'PROCESSED', 'APPLIED', now(), now())`,
      );
      await rejects(
        db.query(
          `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, status, received_at, processed_at)
           VALUES ('c', 'm-1', repeat('b', 64), 'PROCESSED', now(), now())`,
        ),
        { code: '23505', constraint: 'inbox_messages_pk' },
      );
      await rejects(db.query(`UPDATE inbox_messages SET outcome = 'REPLAYED' WHERE message_id = 'm-1'`), {
        constraint: 'inbox_processed_immutable',
      });
    });

    test('outbox: published events are immutable', async () => {
      const event = await db.one<{ id: string }>(`SELECT id FROM outbox_messages LIMIT 1`);
      await db.query(`UPDATE outbox_messages SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [
        event.id,
      ]);
      await rejects(
        db.query(`UPDATE outbox_messages SET status = 'PENDING', published_at = NULL WHERE id = $1`, [
          event.id,
        ]),
        {
          constraint: 'outbox_published_immutable',
        },
      );
      const pending = await db.one<{ id: string }>(
        `SELECT id FROM outbox_messages WHERE status = 'PENDING' LIMIT 1`,
      );
      await rejects(
        db.query(`UPDATE outbox_messages SET payload = '{}'::jsonb WHERE id = $1`, [pending.id]),
        {
          constraint: 'outbox_event_immutable',
        },
      );
    });
  });
});
