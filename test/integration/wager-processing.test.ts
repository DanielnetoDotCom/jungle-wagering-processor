import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ConflictError } from '../../src/application/errors/application-errors';
import type { WagerSubmissionResult } from '../../src/application/use-cases/process-wager-transaction.use-case';
import { RecordDeadLetterUseCase } from '../../src/application/use-cases/record-dead-letter.use-case';
import { wagerPayloadHash } from '../../src/application/services/payload-hash';
import type { Core } from '../../src/bootstrap/core';
import { InvalidMoneyError } from '../../src/domain/errors/domain-errors';
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction-types';
import { expectAllWalletsConsistent, expectWalletConsistent } from '../support/consistency';
import { createTestCore } from '../support/core';
import { TestDatabase } from '../support/database';
import { httpCommand, payload, ScriptedFaults, sqsCommand, uniqueId } from '../support/fixtures';

describe('Wager processing on a real PostgreSQL (shared use case for HTTP and SQS)', () => {
  let db: TestDatabase;
  let core: Core;
  const faults = new ScriptedFaults();

  beforeAll(async () => {
    db = await TestDatabase.create('processing');
    core = await createTestCore(db, { overrides: { faults } });
  });

  beforeEach(() => faults.clear());

  afterAll(async () => {
    await expectAllWalletsConsistent(db);
    await core.close();
    await db.drop();
  });

  async function openWallet(amount = '100.00'): Promise<{ walletId: string; playerId: string }> {
    const playerId = uniqueId('player');
    const wallet = await core.createWallet.execute({
      playerId,
      initialBalance: { amount, currency: 'BRL' },
      correlationId: randomUUID(),
    });
    return { walletId: wallet.id, playerId };
  }

  function recorded(result: WagerSubmissionResult) {
    if (result.type !== 'RECORDED' && result.type !== 'REPLAY') throw new Error(`unexpected ${result.type}`);
    return result.transaction;
  }

  async function events(walletId: string): Promise<string[]> {
    const rows = await db.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_messages WHERE message_group_id = $1 ORDER BY seq`,
      [walletId],
    );
    return rows.map((row) => row.event_type);
  }

  async function ledgerCount(walletId: string): Promise<number> {
    return (
      await db.one<{ count: number }>(
        `SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1`,
        [walletId],
      )
    ).count;
  }

  describe('wallet opening', () => {
    test('positive balance: wallet v1 + OPENING transaction + CREDIT line + events, in one commit', async () => {
      const { walletId } = await openWallet('250.00');
      const wallet = await db.one<{ balance_amount: string; version: number }>(
        `SELECT * FROM wallets WHERE id = $1`,
        [walletId],
      );
      expect(wallet).toMatchObject({ balance_amount: '250.00', version: 1 });
      const opening = await db.one<{ kind: string; status: string; channel: string }>(
        `SELECT kind, status, channel FROM wager_transactions WHERE wallet_id = $1`,
        [walletId],
      );
      expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', channel: 'INTERNAL' });
      const line = await db.one<{
        direction: string;
        balance_before: string;
        balance_after: string;
        wallet_version: number;
      }>(
        `SELECT direction, balance_before, balance_after, wallet_version FROM wallet_ledger_entries WHERE wallet_id = $1`,
        [walletId],
      );
      expect(line).toEqual({
        direction: 'CREDIT',
        balance_before: '0.00',
        balance_after: '250.00',
        wallet_version: 1,
      });
      expect(await events(walletId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    });

    test('zero balance: no artificial transaction or ledger line', async () => {
      const { walletId } = await openWallet('0.00');
      expect(await ledgerCount(walletId)).toBe(0);
      expect(
        (await db.query(`SELECT 1 FROM wager_transactions WHERE wallet_id = $1`, [walletId])).length,
      ).toBe(0);
    });

    test('one wallet per player and currency, even under concurrent creation', async () => {
      const playerId = uniqueId('player');
      const attempts = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          core.createWallet.execute({
            playerId,
            initialBalance: { amount: '10.00', currency: 'BRL' },
            correlationId: 'c',
          }),
        ),
      );
      const created = attempts.filter((attempt) => attempt.status === 'fulfilled');
      const conflicts = attempts.filter(
        (attempt) =>
          attempt.status === 'rejected' &&
          attempt.reason instanceof ConflictError &&
          attempt.reason.code === 'WALLET_ALREADY_EXISTS',
      );
      expect(created).toHaveLength(1);
      expect(conflicts).toHaveLength(9);
      // a second currency for the same player is a different wallet
      await core.createWallet.execute({
        playerId,
        initialBalance: { amount: '1.00', currency: 'USD' },
        correlationId: 'c',
      });
    });
  });

  describe('financial rules', () => {
    test('BET: PROCESSED, one DEBIT line, snapshot and events', async () => {
      const { walletId, playerId } = await openWallet();
      const tx = recorded(
        await core.processWager.execute(
          httpCommand(payload({ walletId, playerId, kind: Kind.Bet, amount: '25.00' })),
        ),
      );
      expect(tx).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      });
      expect(await ledgerCount(walletId)).toBe(2);
      expect((await events(walletId)).slice(2)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      await expectWalletConsistent(db, walletId);
    });

    test('BET without funds: REJECTED, no line, wallet untouched, rejection event', async () => {
      const { walletId, playerId } = await openWallet('10.00');
      const tx = recorded(
        await core.processWager.execute(
          httpCommand(payload({ walletId, playerId, kind: Kind.Bet, amount: '10.01' })),
        ),
      );
      expect(tx).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '10.00' },
        walletVersion: 1,
      });
      expect(await ledgerCount(walletId)).toBe(1);
      expect((await events(walletId)).slice(2)).toEqual(['WagerTransactionRejected']);
    });

    test('LOSS: PROCESSED, no ledger line, version unchanged, only WagerTransactionProcessed', async () => {
      const { walletId, playerId } = await openWallet();
      const bet = recorded(
        await core.processWager.execute(
          httpCommand(
            payload({
              walletId,
              playerId,
              kind: Kind.Bet,
              amount: '5.00',
              externalTransactionId: uniqueId('b'),
            }),
          ),
        ),
      );
      const before = await ledgerCount(walletId);
      const loss = recorded(
        await core.processWager.execute(
          httpCommand(
            payload({
              walletId,
              playerId,
              kind: Kind.Loss,
              amount: '0.00',
              reference: bet.externalTransactionId,
            }),
          ),
        ),
      );
      expect(loss).toMatchObject({ status: 'PROCESSED', walletVersion: 2, balance: { amount: '95.00' } });
      expect(await ledgerCount(walletId)).toBe(before);
      expect((await events(walletId)).at(-1)).toBe('WagerTransactionProcessed');
    });

    test('BET -> WIN -> REFUND -> ROLLBACK chain, double reversal blocked, rollback of the refund allowed', async () => {
      const { walletId, playerId } = await openWallet('100.00');
      const submit = (kind: Kind, amount: string, external: string, reference?: string) =>
        core.processWager.execute(
          httpCommand(
            payload({ walletId, playerId, kind, amount, externalTransactionId: external, reference }),
          ),
        );

      expect(recorded(await submit(Kind.Bet, '40.00', 'bet-a')).balance?.amount).toBe('60.00');
      expect(recorded(await submit(Kind.Win, '15.00', 'win-a', 'bet-a')).balance?.amount).toBe('75.00');
      expect(recorded(await submit(Kind.Refund, '40.00', 'refund-a', 'bet-a')).balance?.amount).toBe(
        '115.00',
      );
      // second reversal of the same BET (different kind) is refused: no double credit
      expect(recorded(await submit(Kind.Rollback, '40.00', 'rollback-bet-a', 'bet-a'))).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REFERENCE_ALREADY_REVERSED',
      });
      // compensating the REFUND is a separate operation on a different reference
      expect(
        recorded(await submit(Kind.Rollback, '40.00', 'rollback-refund-a', 'refund-a')).balance?.amount,
      ).toBe('75.00');
      // and it cannot be compensated twice
      expect(recorded(await submit(Kind.Rollback, '40.00', 'rollback-refund-b', 'refund-a'))).toMatchObject({
        failureCode: 'REFERENCE_ALREADY_REVERSED',
      });
      const audit = await expectWalletConsistent(db, walletId);
      expect(audit.balance).toBe('75.00');
    });

    test('ROLLBACK of a WIN without funds: REVERSAL_INSUFFICIENT_FUNDS, auditable, nothing moved', async () => {
      const { walletId, playerId } = await openWallet('10.00');
      const submit = (kind: Kind, amount: string, external: string, reference?: string) =>
        core.processWager.execute(
          httpCommand(
            payload({ walletId, playerId, kind, amount, externalTransactionId: external, reference }),
          ),
        );
      await submit(Kind.Win, '50.00', 'win-x');
      await submit(Kind.Bet, '55.00', 'bet-x');
      const rollback = recorded(await submit(Kind.Rollback, '50.00', 'rollback-x', 'win-x'));
      expect(rollback).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
        balance: { amount: '5.00' },
      });
      await expectWalletConsistent(db, walletId);
    });

    test('currency and player mismatches are persisted rejections', async () => {
      const { walletId, playerId } = await openWallet();
      const usd = recorded(
        await core.processWager.execute(
          httpCommand(payload({ walletId, playerId, kind: Kind.Bet, amount: '1.00', currency: 'USD' })),
        ),
      );
      expect(usd.failureCode).toBe(FailureCode.CurrencyMismatch);
      const stranger = recorded(
        await core.processWager.execute(
          httpCommand(payload({ walletId, playerId: 'intruder', kind: Kind.Bet, amount: '1.00' })),
        ),
      );
      expect(stranger.failureCode).toBe(FailureCode.PlayerWalletMismatch);
    });

    test('invalid money never reaches the database', async () => {
      const { walletId, playerId } = await openWallet();
      await expect(
        core.processWager.execute(
          httpCommand({
            ...payload({ walletId, playerId, kind: Kind.Bet, amount: '1.00' }),
            money: { amount: '1.001', currency: 'BRL' },
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidMoneyError);
    });
  });

  describe('persistent idempotency', () => {
    test('identical replay returns the ORIGINAL result, including the historical balance', async () => {
      const { walletId, playerId } = await openWallet('100.00');
      const bet = payload({ walletId, playerId, kind: Kind.Bet, amount: '20.00' });
      const original = recorded(await core.processWager.execute(httpCommand(bet)));
      expect(original.balance?.amount).toBe('80.00');

      await core.processWager.execute(
        httpCommand(payload({ walletId, playerId, kind: Kind.Win, amount: '50.00' })),
      );
      await core.processWager.execute(
        httpCommand(payload({ walletId, playerId, kind: Kind.Bet, amount: '1.00' })),
      );

      const replay = await core.processWager.execute(httpCommand(bet));
      expect(replay.type).toBe('REPLAY');
      expect(recorded(replay)).toEqual(original);
      expect(recorded(replay).balance?.amount).toBe('80.00');
      const current = await db.one<{ balance_amount: string }>(
        `SELECT balance_amount FROM wallets WHERE id = $1`,
        [walletId],
      );
      expect(current.balance_amount).toBe('129.00');
    });

    test('a replayed rejection stays a rejection (no second evaluation)', async () => {
      const { walletId, playerId } = await openWallet('5.00');
      const bet = payload({ walletId, playerId, kind: Kind.Bet, amount: '10.00' });
      expect(recorded(await core.processWager.execute(httpCommand(bet))).status).toBe(
        WagerTransactionStatus.Rejected,
      );
      await core.processWager.execute(
        httpCommand(payload({ walletId, playerId, kind: Kind.Win, amount: '100.00' })),
      );
      const replay = await core.processWager.execute(httpCommand(bet));
      expect(replay.type).toBe('REPLAY');
      expect(recorded(replay)).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '5.00' },
      });
    });

    test('same key + different payload is a conflict, not a replay', async () => {
      const { walletId, playerId } = await openWallet();
      const bet = payload({ walletId, playerId, kind: Kind.Bet, amount: '20.00' });
      await core.processWager.execute(httpCommand(bet));
      const conflict = await core.processWager.execute(
        httpCommand({ ...bet, money: { amount: '21.00', currency: 'BRL' } }),
      );
      expect(conflict).toMatchObject({ type: 'CONFLICT', code: 'IDEMPOTENCY_KEY_CONFLICT' });
      expect(await ledgerCount(walletId)).toBe(2);
    });

    test('same externalTransactionId under another key never creates a second operation', async () => {
      const { walletId, playerId } = await openWallet();
      const bet = payload({ walletId, playerId, kind: Kind.Bet, amount: '20.00' });
      await core.processWager.execute(httpCommand(bet, 'key-1'));
      const second = await core.processWager.execute(httpCommand(bet, 'key-2'));
      expect(second).toMatchObject({ type: 'CONFLICT', code: 'DUPLICATE_EXTERNAL_TRANSACTION' });
      expect(await ledgerCount(walletId)).toBe(2);
    });

    test('HTTP then SQS (same operation): one financial effect; inbox records the replay', async () => {
      const { walletId, playerId } = await openWallet();
      const bet = payload({ walletId, playerId, kind: Kind.Bet, amount: '20.00' });
      const http = recorded(await core.processWager.execute(httpCommand(bet)));
      const messageId = uniqueId('msg');
      const viaSqs = await core.processWager.execute(sqsCommand(bet, messageId));
      expect(viaSqs.type).toBe('REPLAY');
      expect(recorded(viaSqs).transactionId).toBe(http.transactionId);
      expect(await ledgerCount(walletId)).toBe(2);
      const inbox = await db.one<{ status: string; outcome: string; transaction_id: string }>(
        `SELECT status, outcome, transaction_id FROM inbox_messages WHERE message_id = $1`,
        [messageId],
      );
      expect(inbox).toEqual({ status: 'PROCESSED', outcome: 'REPLAYED', transaction_id: http.transactionId });

      // the same message redelivered is answered from the inbox
      const redelivery = await core.processWager.execute(sqsCommand(bet, messageId));
      expect(redelivery).toMatchObject({ type: 'DUPLICATE_MESSAGE', outcome: 'REPLAYED' });
      // the same message id with another payload is a permanent conflict
      const reused = await core.processWager.execute(
        sqsCommand({ ...bet, money: { amount: '1.00', currency: 'BRL' } }, messageId),
      );
      expect(reused.type).toBe('MESSAGE_ID_CONFLICT');
    });

    test('SQS then HTTP (same operation): HTTP gets the replay', async () => {
      const { walletId, playerId } = await openWallet();
      const bet = payload({ walletId, playerId, kind: Kind.Bet, amount: '20.00' });
      const viaSqs = recorded(await core.processWager.execute(sqsCommand(bet, uniqueId('msg'))));
      const http = await core.processWager.execute(httpCommand(bet));
      expect(http).toMatchObject({ type: 'REPLAY', transaction: { transactionId: viaSqs.transactionId } });
    });

    test('a dead-lettered message id (no hash, or an old hash) is processed once resent, then deduplicated', async () => {
      const { walletId, playerId } = await openWallet();
      const deadLetters = new RecordDeadLetterUseCase(core.uow, core.clock);
      const consumerName = 'test-consumer';

      // 1) dead-lettered as unparseable: no payload hash was recorded
      const unparseableId = uniqueId('msg');
      await deadLetters.execute({
        consumerName,
        messageId: unparseableId,
        payloadHash: undefined,
        receiveCount: 1,
        errorCode: 'INVALID_MESSAGE',
      });
      const corrected = payload({ walletId, playerId, kind: Kind.Bet, amount: '4.00' });
      expect(
        (await core.processWager.execute(sqsCommand(corrected, unparseableId, undefined, consumerName))).type,
      ).toBe('RECORDED');
      expect(
        (await core.processWager.execute(sqsCommand(corrected, unparseableId, undefined, consumerName))).type,
      ).toBe('DUPLICATE_MESSAGE');

      // 2) dead-lettered with the hash of an older payload: the processed payload wins
      const staleId = uniqueId('msg');
      const older = payload({ walletId, playerId, kind: Kind.Bet, amount: '1.00' });
      await deadLetters.execute({
        consumerName,
        messageId: staleId,
        payloadHash: wagerPayloadHash(older),
        receiveCount: 5,
        errorCode: 'PROCESSING_FAILED',
      });
      const resent = payload({ walletId, playerId, kind: Kind.Bet, amount: '6.00' });
      expect(
        (await core.processWager.execute(sqsCommand(resent, staleId, undefined, consumerName))).type,
      ).toBe('RECORDED');
      expect(
        (await core.processWager.execute(sqsCommand(resent, staleId, undefined, consumerName))).type,
      ).toBe('DUPLICATE_MESSAGE');

      const rows = await db.query<{ status: string; payload_hash: string }>(
        `SELECT status, payload_hash FROM inbox_messages WHERE message_id = ANY($1) ORDER BY payload_hash`,
        [[unparseableId, staleId]],
      );
      expect(rows.map((row) => row.status)).toEqual(['PROCESSED', 'PROCESSED']);
      expect(rows.map((row) => row.payload_hash).sort()).toEqual(
        [wagerPayloadHash(corrected), wagerPayloadHash(resent)].sort(),
      );
      expect((await expectWalletConsistent(db, walletId)).balance).toBe('90.00');
    });

    test('unknown wallet: not applied, nothing persisted (SQS: inbox remembers the outcome)', async () => {
      const ghost = randomUUID();
      const bet = payload({ walletId: ghost, playerId: 'p', kind: Kind.Bet, amount: '1.00' });
      expect((await core.processWager.execute(httpCommand(bet))).type).toBe('WALLET_NOT_FOUND');
      const messageId = uniqueId('msg');
      expect((await core.processWager.execute(sqsCommand(bet, messageId))).type).toBe('WALLET_NOT_FOUND');
      expect((await core.processWager.execute(sqsCommand(bet, messageId))).type).toBe('DUPLICATE_MESSAGE');
      expect((await db.query(`SELECT 1 FROM wager_transactions WHERE wallet_id = $1`, [ghost])).length).toBe(
        0,
      );
    });
  });

  describe('atomicity', () => {
    async function snapshot(walletId: string) {
      return db.one<{
        balance: string;
        version: number;
        transactions: number;
        lines: number;
        events: number;
        inbox: number;
      }>(
        `SELECT (SELECT balance_amount FROM wallets WHERE id = $1) AS balance,
                (SELECT version FROM wallets WHERE id = $1) AS version,
                (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = $1) AS transactions,
                (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = $1) AS lines,
                (SELECT count(*)::int FROM outbox_messages WHERE message_group_id = $1::text) AS events,
                (SELECT count(*)::int FROM inbox_messages) AS inbox`,
        [walletId],
      );
    }

    test('a failure after every write but before COMMIT leaves no partial state (HTTP and SQS)', async () => {
      const { walletId, playerId } = await openWallet();
      const before = await snapshot(walletId);
      faults.on('wager.before-commit', () => Promise.reject(new Error('process died before commit')));

      const bet = payload({ walletId, playerId, kind: Kind.Bet, amount: '30.00' });
      await expect(core.processWager.execute(httpCommand(bet))).rejects.toThrow('process died before commit');
      await expect(core.processWager.execute(sqsCommand(bet, uniqueId('msg')))).rejects.toThrow(
        'process died before commit',
      );
      expect(await snapshot(walletId)).toEqual(before);

      faults.clear();
      const retried = recorded(await core.processWager.execute(httpCommand(bet)));
      expect(retried).toMatchObject({ status: 'PROCESSED', balance: { amount: '70.00' } });
      expect((await snapshot(walletId)).lines).toBe(before.lines + 1);
    });
  });
});
