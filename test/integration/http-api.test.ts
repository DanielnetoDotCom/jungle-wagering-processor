import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Core } from '../../src/bootstrap/core';
import { createNestApp } from '../../src/bootstrap/nest/create-app';
import { ApiModule } from '../../src/bootstrap/nest/modules';
import { expectAllWalletsConsistent } from '../support/consistency';
import { createTestCore } from '../support/core';
import { TestDatabase } from '../support/database';
import { uniqueId, waitFor } from '../support/fixtures';
import { TestQueues } from '../support/sqs';

interface Response<T = Record<string, unknown>> {
  status: number;
  headers: Headers;
  body: T;
}

describe('REST API (Nest + Express, real PostgreSQL and SQS)', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let core: Core;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    db = await TestDatabase.create('http');
    queues = await TestQueues.create('http');
    core = await createTestCore(db, {
      queues: queues.names,
      env: { DB_ACQUIRE_TIMEOUT_MS: '1500', DB_CONNECT_TIMEOUT_MS: '1000' },
    });
    app = await createNestApp(core, ApiModule.register(core));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await expectAllWalletsConsistent(db);
    await app.close(); // also closes the core (ORM + SQS client)
    await queues.destroy();
    await db.drop();
  });

  async function call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response<T>> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : {}) as T };
  }

  async function createWallet(amount = '100.00'): Promise<{ walletId: string; playerId: string }> {
    const playerId = uniqueId('player');
    const response = await call<{ id: string }>('POST', '/wallets', {
      playerId,
      initialBalance: { amount, currency: 'BRL' },
    });
    expect(response.status).toBe(201);
    return { walletId: response.body.id, playerId };
  }

  function wager(walletId: string, playerId: string, overrides: Record<string, unknown> = {}) {
    return {
      providerId: 'provider-a',
      externalTransactionId: uniqueId('tx'),
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...overrides,
    };
  }

  const submit = (
    body: Record<string, unknown>,
    key = `provider-a:${String(body.externalTransactionId)}`,
    headers: Record<string, string> = {},
  ) => call('POST', '/wagering/transactions', body, { 'Idempotency-Key': key, ...headers });

  describe('wallets', () => {
    test('POST /wallets -> 201 with Location and the README contract', async () => {
      const playerId = uniqueId('player');
      const response = await call('POST', '/wallets', {
        playerId,
        initialBalance: { amount: '1000.00', currency: 'BRL' },
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        playerId,
        balance: { amount: '1000.00', currency: 'BRL' },
        version: 1,
      });
      expect(response.headers.get('location')).toBe(`/wallets/${String(response.body.id)}`);
    });

    test('duplicate player+currency -> 409 WALLET_ALREADY_EXISTS (with the existing id)', async () => {
      const { walletId, playerId } = await createWallet();
      const response = await call('POST', '/wallets', {
        playerId,
        initialBalance: { amount: '1.00', currency: 'BRL' },
      });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'WALLET_ALREADY_EXISTS',
        retryable: false,
        details: { walletId },
      });
    });

    test('invalid payloads -> 400 VALIDATION_ERROR listing the issues', async () => {
      const amountAsNumber = await call('POST', '/wallets', {
        playerId: 'p',
        initialBalance: { amount: 10, currency: 'BRL' },
      });
      expect(amountAsNumber.status).toBe(400);
      expect(amountAsNumber.body).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false });
      expect((amountAsNumber.body.details as { issues: Array<{ path: string }> }).issues[0]?.path).toBe(
        'initialBalance.amount',
      );

      const notAccepted = await call('POST', '/wallets', {
        playerId: 'p2',
        initialBalance: { amount: '1.00', currency: 'EUR' },
      });
      expect(notAccepted).toMatchObject({ status: 400, body: { code: 'VALIDATION_ERROR' } });

      const malformed = await call('POST', '/wallets', '{"playerId":');
      expect(malformed).toMatchObject({
        status: 400,
        body: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON' },
      });
    });

    test('GET /wallets/:id -> 200, 404 or 400', async () => {
      const { walletId } = await createWallet();
      expect((await call('GET', `/wallets/${walletId}`)).body).toMatchObject({ id: walletId, version: 1 });
      expect(await call('GET', `/wallets/${randomUUID()}`)).toMatchObject({
        status: 404,
        body: { code: 'WALLET_NOT_FOUND' },
      });
      expect(await call('GET', '/wallets/not-a-uuid')).toMatchObject({
        status: 400,
        body: { code: 'VALIDATION_ERROR' },
      });
    });
  });

  describe('POST /wagering/transactions', () => {
    test('currency mismatch retains the wallet currency on replay and both GET routes', async () => {
      const { walletId, playerId } = await createWallet();
      const body = wager(walletId, playerId, { money: { amount: '10.00', currency: 'USD' } });
      const first = await submit(body);
      expect(first).toMatchObject({
        status: 422,
        body: { balance: { amount: '100.00', currency: 'BRL' } },
      });
      await submit(wager(walletId, playerId)); // Move the wallet after recording the rejection.
      const replay = await submit(body);
      expect(replay.body).toEqual({
        ...first.body,
        correlationId: replay.body.correlationId,
        idempotentReplay: true,
      });
      for (const path of [
        `/wagering/transactions/${String(first.body.transactionId)}`,
        `/providers/provider-a/wagering/transactions/${String(body.externalTransactionId)}`,
      ]) {
        expect((await call('GET', path)).body).toMatchObject({
          balance: { amount: '100.00', currency: 'BRL' },
        });
      }
    });

    test('201 PROCESSED, then 200 replay with the same body and idempotentReplay=true', async () => {
      const { walletId, playerId } = await createWallet();
      const body = wager(walletId, playerId, { money: { amount: '25.00', currency: 'BRL' } });
      const first = await submit(body);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: '75.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      expect(first.headers.get('location')).toBe(
        `/wagering/transactions/${String(first.body.transactionId)}`,
      );

      const replay = await submit(body);
      expect(replay.status).toBe(200);
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    });

    test('Idempotency-Key is mandatory', async () => {
      const { walletId, playerId } = await createWallet();
      const response = await call('POST', '/wagering/transactions', wager(walletId, playerId));
      expect(response).toMatchObject({
        status: 400,
        body: { code: 'VALIDATION_ERROR', message: 'Invalid Idempotency-Key header' },
      });
    });

    test('same key + different payload -> 409 IDEMPOTENCY_KEY_CONFLICT (not a replay)', async () => {
      const { walletId, playerId } = await createWallet();
      const body = wager(walletId, playerId);
      await submit(body);
      const conflict = await submit({ ...body, money: { amount: '11.00', currency: 'BRL' } });
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', retryable: false });
    });

    test('business rejection -> 422 with failureCode, transaction id and the observed balance', async () => {
      const { walletId, playerId } = await createWallet('5.00');
      const response = await submit(
        wager(walletId, playerId, { money: { amount: '50.00', currency: 'BRL' } }),
      );
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({
        code: 'INSUFFICIENT_FUNDS',
        failureCode: 'INSUFFICIENT_FUNDS',
        retryable: false,
        status: 'REJECTED',
        balance: { amount: '5.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      expect(typeof response.body.transactionId).toBe('string');
      expect(typeof response.body.correlationId).toBe('string');
    });

    test('reference not available yet -> 202 Accepted, pollable via Location', async () => {
      const { walletId, playerId } = await createWallet();
      const response = await submit(
        wager(walletId, playerId, { kind: 'REFUND', referenceExternalTransactionId: uniqueId('later') }),
      );
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });
      const location = response.headers.get('location') ?? '';
      expect((await call('GET', location)).body).toMatchObject({
        status: 'PENDING_REFERENCE',
        kind: 'REFUND',
      });
    });

    test('contract violations -> 400 (OPENING, unknown field, bad amount, missing reference)', async () => {
      const { walletId, playerId } = await createWallet();
      for (const body of [
        wager(walletId, playerId, { kind: 'OPENING' }),
        wager(walletId, playerId, { extra: 'field' }),
        wager(walletId, playerId, { money: { amount: '10.5', currency: 'BRL' } }),
        wager(walletId, playerId, { kind: 'ROLLBACK' }),
      ]) {
        expect((await submit(body)).status).toBe(400);
      }
    });

    test('unknown wallet -> 404 WALLET_NOT_FOUND', async () => {
      const response = await submit(wager(randomUUID(), 'player'));
      expect(response).toMatchObject({ status: 404, body: { code: 'WALLET_NOT_FOUND' } });
    });

    test('UUIDs in upper case are the same wallet and the same operation', async () => {
      const { walletId, playerId } = await createWallet();
      const body = wager(walletId.toUpperCase(), playerId);
      const first = await submit(body);
      expect(first).toMatchObject({
        status: 201,
        body: { status: 'PROCESSED', balance: { amount: '90.00' } },
      });
      const replay = await submit({ ...body, walletId });
      expect(replay).toMatchObject({
        status: 200,
        body: { idempotentReplay: true, transactionId: first.body.transactionId },
      });
      expect((await call('GET', `/wallets/${walletId.toUpperCase()}`)).body).toMatchObject({ id: walletId });
    });

    test('correlation id is propagated to headers and error bodies', async () => {
      const response = await call('GET', `/wallets/${randomUUID()}`, undefined, {
        'X-Correlation-Id': 'trace-abc-123',
      });
      expect(response.headers.get('x-correlation-id')).toBe('trace-abc-123');
      expect(response.body.correlationId).toBe('trace-abc-123');
      expect(response.headers.get('x-instance-id')).toBeTruthy();
    });
  });

  describe('queries', () => {
    test('transaction by id and by provider external id', async () => {
      const { walletId, playerId } = await createWallet();
      const body = wager(walletId, playerId);
      const created = await submit(body);
      const byId = await call('GET', `/wagering/transactions/${String(created.body.transactionId)}`);
      expect(byId.body).toMatchObject({
        transactionId: created.body.transactionId,
        kind: 'BET',
        status: 'PROCESSED',
        money: { amount: '10.00' },
      });
      const byExternal = await call(
        'GET',
        `/providers/provider-a/wagering/transactions/${String(body.externalTransactionId)}`,
      );
      expect(byExternal.body.transactionId).toBe(created.body.transactionId);
      expect(await call('GET', `/wagering/transactions/${randomUUID()}`)).toMatchObject({
        status: 404,
        body: { code: 'TRANSACTION_NOT_FOUND' },
      });
    });

    test('ledger keyset pagination with an opaque, wallet-bound cursor', async () => {
      const { walletId, playerId } = await createWallet('100.00');
      for (let index = 0; index < 6; index += 1)
        await submit(wager(walletId, playerId, { money: { amount: '1.00', currency: 'BRL' } }));

      const versions: number[] = [];
      let cursor: string | null = null;
      do {
        const page: Response<{ items: Array<{ walletVersion: number }>; nextCursor: string | null }> =
          await call('GET', `/wallets/${walletId}/ledger?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
        expect(page.status).toBe(200);
        versions.push(...page.body.items.map((item) => item.walletVersion));
        cursor = page.body.nextCursor;
      } while (cursor);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7]);

      const descending = await call<{ items: Array<{ walletVersion: number }> }>(
        'GET',
        `/wallets/${walletId}/ledger?order=desc&limit=2`,
      );
      expect(descending.body.items.map((item) => item.walletVersion)).toEqual([7, 6]);

      expect((await call('GET', `/wallets/${walletId}/ledger?cursor=bogus`)).status).toBe(400);
      expect((await call('GET', `/wallets/${walletId}/ledger?limit=500`)).status).toBe(400);
    });

    test('POST /wallets/:id/reconciliation -> 200 with the README fields', async () => {
      const { walletId, playerId } = await createWallet('975.00');
      await submit(wager(walletId, playerId));
      const response = await call('POST', `/wallets/${walletId}/reconciliation`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        walletId,
        storedBalance: { amount: '965.00', currency: 'BRL' },
        calculatedBalance: { amount: '965.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 2,
      });
    });
  });

  describe('operations', () => {
    test('health, metrics and unknown routes', async () => {
      expect(await call('GET', '/health/live')).toMatchObject({ status: 200, body: { status: 'ok' } });
      const ready = await call('GET', '/health/ready');
      expect(ready).toMatchObject({
        status: 200,
        body: { status: 'ready', checks: { postgres: { status: 'up' }, sqs: { status: 'up' } } },
      });
      const metrics = await fetch(`${baseUrl}/metrics`);
      expect(metrics.headers.get('content-type')).toContain('text/plain');
      const text = await metrics.text();
      expect(text).toContain('wagering_http_requests_total');
      expect(text).toContain('wagering_transactions_total');
      expect(await call('GET', '/nope')).toMatchObject({ status: 404, body: { code: 'ROUTE_NOT_FOUND' } });
    });

    test('PostgreSQL unavailable: 503 retryable + not ready (live stays up), then automatic recovery', async () => {
      const { walletId, playerId } = await createWallet();
      // Make the database refuse connections and kill the pool's current ones.
      await db.control(`ALTER DATABASE ${db.name} WITH ALLOW_CONNECTIONS false`);
      await db.control(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db.name}' AND usename <> current_user`,
      );
      try {
        const body = wager(walletId, playerId);
        const down = await waitFor(
          async () => {
            const response = await submit(body);
            return response.status === 503 ? response : undefined;
          },
          { timeoutMs: 20_000, description: '503 while the database is down' },
        );
        expect(down.body).toMatchObject({ code: 'DATABASE_UNAVAILABLE', retryable: true });
        expect(down.headers.get('retry-after')).toBe('1');
        expect((await call('GET', '/health/ready')).status).toBe(503);
        expect((await call('GET', '/health/live')).status).toBe(200);
      } finally {
        await db.control(`ALTER DATABASE ${db.name} WITH ALLOW_CONNECTIONS true`);
      }
      await waitFor(async () => (await call('GET', '/health/ready')).status === 200, {
        timeoutMs: 20_000,
        description: 'recovery',
      });
      const retried = await submit(wager(walletId, playerId, { externalTransactionId: uniqueId('after') }));
      expect(retried.status).toBe(201);
    });
  });
});
