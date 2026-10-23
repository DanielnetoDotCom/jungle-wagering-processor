import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { Core } from '../../src/bootstrap/core';
import { Money } from '../../src/domain/money/money';
import type { SqlEntityManager } from '@mikro-orm/postgresql';
import {
  IntegrityViolationError,
  TransientInfrastructureError,
} from '../../src/application/errors/application-errors';
import { describeError } from '../../src/infrastructure/logging/logger';
import { WalletRecord } from '../../src/infrastructure/persistence/mikroorm/records';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import type { UnitOfWork } from '../../src/application/ports/persistence.ports';
import { createTestCore } from '../support/core';
import { TestDatabase } from '../support/database';
import { expectAllWalletsConsistent } from '../support/consistency';
import { httpCommand, payload, ScriptedFaults, sqsCommand, uniqueId } from '../support/fixtures';

describe('Audit regressions against PostgreSQL', () => {
  let db: TestDatabase;
  let core: Core;
  const faults = new ScriptedFaults();

  beforeAll(async () => {
    db = await TestDatabase.create('audit_regressions');
    core = await createTestCore(db, { overrides: { faults } });
  });

  afterAll(async () => {
    await expectAllWalletsConsistent(db);
    await core.close();
    await db.drop();
  });

  const open = (amount = '0.00') =>
    core.createWallet.execute({
      playerId: uniqueId('audit-player'),
      initialBalance: { amount, currency: 'BRL' },
      correlationId: 'audit',
    });

  async function rawCredit(
    client: Client,
    wallet: { id: string; playerId: string },
    version: number,
    before: string,
    amount: string,
    after: string,
  ): Promise<void> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key, payload_hash, channel, wallet_id,
       player_id, round_id, game_id, kind, amount, currency, status, result_balance_amount,
       result_wallet_version, created_at, updated_at, processed_at)
      VALUES ($1::uuid, 'audit', $1::varchar, $1::varchar, repeat('a',64), 'HTTP', $2, $3, 'r', 'g', 'WIN', $4,
              'BRL', 'PROCESSED', $5, $6, now(), now(), now())`,
      [id, wallet.id, wallet.playerId, amount, after, version],
    );
    await client.query(
      `INSERT INTO wallet_ledger_entries VALUES
      (gen_random_uuid(), $1, $2, 'CREDIT', $3, 'BRL', $4, $5, $6, now())`,
      [wallet.id, id, amount, before, after, version],
    );
  }

  test('runtime SQL cannot backfill unused version 1 underneath a zero-opening wallet', async () => {
    const wallet = await open();
    await core.processWager.execute(
      httpCommand(payload({ walletId: wallet.id, playerId: wallet.playerId, kind: 'WIN', amount: '20.00' })),
    );
    const client = await db.appClient();
    try {
      await client.query('BEGIN');
      await rawCredit(client, wallet, 1, '0.00', '10.00', '10.00');
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
        constraint: 'ledger_chain_successor',
      });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
    expect(
      await db.one(`SELECT balance_amount::text AS balance, version FROM wallets WHERE id=$1`, [wallet.id]),
    ).toEqual({ balance: '20.00', version: 2 });
    expect(
      await db.one(`SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id=$1`, [
        wallet.id,
      ]),
    ).toEqual({ count: 1 });
  });

  test('several consecutive credits can legitimately commit in one SQL transaction', async () => {
    const wallet = await open();
    const client = await db.appClient();
    try {
      await client.query('BEGIN');
      for (const [version, before, amount, after] of [
        [2, '0.00', '10.00', '10.00'],
        [3, '10.00', '20.00', '30.00'],
      ] as const) {
        await client.query('UPDATE wallets SET balance_amount=$2, version=$3 WHERE id=$1', [
          wallet.id,
          after,
          version,
        ]);
        await rawCredit(client, wallet, version, before, amount, after);
      }
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
    expect((await core.reconcileWallet.execute(wallet.id)).consistent).toBe(true);
  });

  test('concurrent runtime backfill attempts are all rolled back', async () => {
    const wallet = await open();
    await core.processWager.execute(
      httpCommand(payload({ walletId: wallet.id, playerId: wallet.playerId, kind: 'WIN', amount: '20.00' })),
    );
    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, async () => {
        const client = await db.appClient();
        try {
          await client.query('BEGIN');
          await rawCredit(client, wallet, 1, '0.00', '10.00', '10.00');
          await client.query('COMMIT');
        } finally {
          await client.query('ROLLBACK');
          await client.end();
        }
      }),
    );
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected')
        expect(outcome.reason).toMatchObject({ code: '23514', constraint: 'ledger_chain_successor' });
    }
    expect((await core.reconcileWallet.execute(wallet.id)).consistent).toBe(true);
  });

  test('runtime SQL cannot insert NaN into any financial NUMERIC column', async () => {
    const wallet = await open();
    const client = await db.appClient();
    try {
      await expect(
        client.query(`INSERT INTO wallets VALUES ($1,$2,'BRL','NaN',1,now(),now())`, [
          randomUUID(),
          uniqueId('nan'),
        ]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'wallets_balance_finite_ck' });
      for (const column of ['amount', 'result_balance_amount']) {
        const id = randomUUID();
        await expect(
          client.query(
            `INSERT INTO wager_transactions
          (id,provider_id,external_transaction_id,idempotency_key,payload_hash,channel,wallet_id,player_id,round_id,game_id,
           kind,amount,currency,status,failure_code,result_balance_amount,result_wallet_version,created_at,updated_at,processed_at)
          VALUES ($1::uuid,'audit',$1::varchar,$1::varchar,repeat('a',64),'HTTP',$2,$3,'r','g','WIN',${column === 'amount' ? "'NaN'" : '1'},'BRL',
                  'REJECTED','X',${column === 'result_balance_amount' ? "'NaN'" : '0'},1,now(),now(),now())`,
            [id, wallet.id, wallet.playerId],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'wager_tx_money_finite_ck' });
      }
      const settled = await core.processWager.execute(
        httpCommand(payload({ walletId: wallet.id, playerId: wallet.playerId, kind: 'WIN', amount: '1.00' })),
      );
      if (settled.type !== 'RECORDED') throw new Error('Setup failed');
      for (const column of ['amount', 'balance_before', 'balance_after']) {
        // A deferred FK and a fresh transaction id keep uniqueness/FK errors from hiding the CHECK.
        const values = ['amount', 'balance_before', 'balance_after'].map((name) =>
          name === column ? "'NaN'" : '1',
        );
        await expect(
          client.query(
            `INSERT INTO wallet_ledger_entries VALUES
          (gen_random_uuid(),$1,gen_random_uuid(),'CREDIT',${values[0]},'BRL',${values[1]},${values[2]},3,now())`,
            [wallet.id],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }
      // NaN = NaN in PostgreSQL, so the old arithmetic checks accepted this.
      await expect(
        client.query(
          `INSERT INTO wallet_ledger_entries VALUES
        (gen_random_uuid(),$1,gen_random_uuid(),'CREDIT','NaN','BRL','NaN','NaN',3,now())`,
          [wallet.id],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'ledger_money_finite_ck' });
    } finally {
      await client.end();
    }
  });

  test('database errors never carry SQL bindings or row values into what gets logged', async () => {
    const secret = uniqueId('secret-player');
    const logged = async (work: (em: SqlEntityManager) => Promise<unknown>) => {
      const error: unknown = await core.uow
        .run(() => work(core.orm.em.fork()))
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      return { error, text: JSON.stringify(describeError(error)) };
    };

    // Hand-written SQL: knex used to inline the bindings into the message.
    const bound = await logged((em) =>
      em
        .getKnex()
        .raw(`INSERT INTO wallets VALUES (?, ?, 'BRL', -1, 1, now(), now())`, [randomUUID(), secret]),
    );
    expect(bound.error).toBeInstanceOf(IntegrityViolationError);
    expect(bound.text).toContain('wallets_balance_non_negative_ck');
    expect(bound.text).not.toContain(secret);

    // ORM flush: the PostgreSQL detail ("Failing row contains (...)") used to be appended.
    const flushed = await logged(async (em) => {
      const now = new Date();
      em.persist(
        em.create(WalletRecord, {
          id: randomUUID(),
          playerId: secret,
          currency: 'BRL',
          balanceAmount: '-1.00',
          version: 1,
          createdAt: now,
          updatedAt: now,
        }),
      );
      await em.flush();
    });
    expect(flushed.error).toBeInstanceOf(IntegrityViolationError);
    expect(flushed.text).not.toContain(secret);
    expect(flushed.text).not.toContain('-1.00');

    // Errors without a dedicated mapping (here 22P02) quote the offending value.
    const unmapped = await logged((em) =>
      em.getKnex().raw('SELECT 1 FROM wallets WHERE id = ?::uuid', [secret]),
    );
    expect(unmapped.text).toContain('22P02');
    expect(unmapped.text).not.toContain(secret);
  });

  async function recorded(): Promise<number> {
    const rendered = await core.metrics.render();
    return rendered
      .split('\n')
      .filter((line) => line.startsWith('wagering_transactions_total{'))
      .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(' ') + 1)), 0);
  }

  test('HTTP and SQS rollback do not increment recorded transactions; a retry counts once', async () => {
    const wallet = await open('100.00');
    for (const channel of ['HTTP', 'SQS']) {
      const before = await recorded();
      const body = payload({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '1.00' });
      faults.on('wager.before-commit', () => Promise.reject(new Error('injected rollback')));
      const command = channel === 'HTTP' ? httpCommand(body) : sqsCommand(body, uniqueId('message'));
      try {
        await expect(core.processWager.execute(command)).rejects.toThrow('injected rollback');
      } finally {
        faults.clear();
      }
      expect(await recorded()).toBe(before);
      let attempts = 0;
      faults.on('wager.before-commit', () =>
        ++attempts === 1
          ? Promise.reject(
              new TransientInfrastructureError('CONCURRENCY_CONFLICT', 'test serialization', 'serialization'),
            )
          : Promise.resolve(),
      );
      try {
        await core.processWager.execute(command);
      } finally {
        faults.clear();
      }
      expect(attempts).toBe(2);
      expect(await recorded()).toBe(before + 1);
    }
  });

  test('OPENING observations are discarded if its unit of work rolls back', async () => {
    const before = await recorded();
    const uow: UnitOfWork = {
      run: (work, options) =>
        core.uow.run(async (scope) => {
          await work(scope);
          throw new Error('opening rollback');
        }, options),
    };
    const create = new CreateWalletUseCase(
      uow,
      core.clock,
      core.ids,
      core.metrics,
      core.logger,
      core.config.acceptedCurrencies,
    );
    await expect(
      create.execute({
        playerId: uniqueId('opening-rollback'),
        initialBalance: { amount: '10.00', currency: 'BRL' },
        correlationId: 'c',
      }),
    ).rejects.toThrow('opening rollback');
    expect(await recorded()).toBe(before);
  });

  test('reference settlement rollback does not report a committed settlement', async () => {
    const wallet = await open('100.00');
    const betId = uniqueId('late-bet');
    const pending = await core.processWager.execute(
      httpCommand(
        payload({
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: 'REFUND',
          amount: '10.00',
          reference: betId,
        }),
      ),
    );
    if (pending.type !== 'RECORDED') throw new Error('Setup failed');
    await core.processWager.execute(
      httpCommand(
        payload({
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: 'BET',
          amount: '10.00',
          externalTransactionId: betId,
        }),
      ),
    );
    const before = await recorded();
    const claim = { walletId: wallet.id, transactionId: pending.transaction.transactionId };
    faults.on('reference.before-commit', () =>
      Promise.reject(new TransientInfrastructureError('DATABASE_UNAVAILABLE', 'injected outage')),
    );
    try {
      await expect(core.resolvePendingReference.execute(claim, 'audit-worker')).rejects.toMatchObject({
        code: 'DATABASE_UNAVAILABLE',
      });
    } finally {
      faults.clear();
    }
    expect(await recorded()).toBe(before);
    await core.resolvePendingReference.execute(claim, 'audit-worker');
    expect(await recorded()).toBe(before + 1);
  });

  test('a deferred COMMIT failure discards observations; a failing observer cannot fail a committed result', async () => {
    const wallet = await open();
    let observations = 0;
    await expect(
      core.uow.run(async (scope) => {
        scope.afterCommit(() => {
          observations += 1;
        });
        const { wallet: locked } = await scope.wallets.lockById(wallet.id);
        if (!locked) throw new Error('Missing wallet');
        locked.credit({
          money: Money.from({ amount: '1.00', currency: 'BRL' }),
          transactionId: randomUUID(),
          ledgerEntryId: randomUUID(),
          at: new Date(),
        });
        scope.wallets.save(locked); // Deliberately omit the ledger: rejected at COMMIT.
      }),
    ).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
    expect(observations).toBe(0);
    expect(
      await core.uow.run(async (scope) => {
        await scope.wallets.findById(wallet.id);
        scope.afterCommit(() => {
          throw new Error('broken metrics sink');
        });
        scope.afterCommit(() => {
          observations += 1;
        });
        return 'committed';
      }),
    ).toBe('committed');
    expect(observations).toBe(1);
  });
});
