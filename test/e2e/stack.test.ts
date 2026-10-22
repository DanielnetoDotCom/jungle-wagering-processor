import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { testInfra } from '../support/environment';
import { uniqueId, waitFor } from '../support/fixtures';

/**
 * End-to-end against the running `docker compose` stack:
 * client -> nginx -> 3 API replicas; SQS -> 3 consumer replicas; outbox
 * workers -> wager-events.fifo; reference worker. Verifies HTTP results AND
 * the database (ledger, inbox, outbox) AND the broker.
 *
 *   docker compose up -d --build
 *   docker compose --profile tools run --rm toolbox bun run test:e2e
 */
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const QUEUE_BASE = `${testInfra.awsEndpoint}/000000000000`;

describe('E2E: docker compose stack', () => {
  let db: Pool;
  let sqs: SQSClient;
  const touchedWallets: string[] = [];

  beforeAll(async () => {
    db = new Pool({
      host: testInfra.dbHost,
      port: testInfra.dbPort,
      user: testInfra.adminUser,
      password: testInfra.adminPassword,
      database: process.env.E2E_DB_NAME ?? 'wagering',
      max: 4,
    });
    sqs = new SQSClient({
      region: testInfra.awsRegion,
      endpoint: testInfra.awsEndpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const ready = await fetch(`${BASE_URL}/health/ready`).catch(() => undefined);
    if (!ready?.ok)
      throw new Error(`Stack not ready at ${BASE_URL}: run "docker compose up -d --build" first`);
  });

  afterAll(async () => {
    // Final invariant for every wallet this suite touched, through the public API.
    for (const walletId of touchedWallets) {
      const report = await call<{ consistent: boolean }>('POST', `/wallets/${walletId}/reconciliation`);
      expect(report.body.consistent).toBe(true);
    }
    await db.end();
    sqs.destroy();
  });

  async function call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : {}) as T };
  }

  async function createWallet(amount = '100.00') {
    const playerId = randomUUID();
    const response = await call<{ id: string }>('POST', '/wallets', {
      playerId,
      initialBalance: { amount, currency: 'BRL' },
    });
    expect(response.status).toBe(201);
    touchedWallets.push(response.body.id);
    return { walletId: response.body.id, playerId };
  }

  function wager(walletId: string, playerId: string, overrides: Record<string, unknown> = {}) {
    return {
      providerId: 'provider-e2e',
      externalTransactionId: uniqueId('e2e'),
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...overrides,
    } as Record<string, unknown> & { externalTransactionId: string };
  }

  const submit = (body: Record<string, unknown> & { externalTransactionId: string }) =>
    call('POST', '/wagering/transactions', body, {
      'Idempotency-Key': `provider-e2e:${body.externalTransactionId}`,
    });

  test('nginx distributes requests across the three API replicas', async () => {
    const instances = new Set<string>();
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${BASE_URL}/health/live`);
      instances.add(response.headers.get('x-instance-id') ?? '');
    }
    expect(instances.size).toBeGreaterThanOrEqual(3);
  });

  test('BET, WIN, LOSS, REFUND, ROLLBACK through the load balancer, with DB verification', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const bet = wager(walletId, playerId, { money: { amount: '40.00', currency: 'BRL' } });
    expect((await submit(bet)).body).toMatchObject({ status: 'PROCESSED', balance: { amount: '60.00' } });
    const win = wager(walletId, playerId, {
      kind: 'WIN',
      referenceExternalTransactionId: bet.externalTransactionId,
      money: { amount: '15.00', currency: 'BRL' },
    });
    expect((await submit(win)).body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' } });
    const loss = wager(walletId, playerId, {
      kind: 'LOSS',
      referenceExternalTransactionId: bet.externalTransactionId,
      money: { amount: '0.00', currency: 'BRL' },
    });
    expect((await submit(loss)).body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00' },
      walletVersion: 3,
    });
    const refund = wager(walletId, playerId, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
      money: { amount: '40.00', currency: 'BRL' },
    });
    expect((await submit(refund)).body).toMatchObject({ status: 'PROCESSED', balance: { amount: '115.00' } });
    const rollback = wager(walletId, playerId, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: win.externalTransactionId,
      money: { amount: '15.00', currency: 'BRL' },
    });
    expect((await submit(rollback)).body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00' },
    });
    const doubleReversal = wager(walletId, playerId, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: bet.externalTransactionId,
      money: { amount: '40.00', currency: 'BRL' },
    });
    expect(await submit(doubleReversal)).toMatchObject({
      status: 422,
      body: { code: 'REFERENCE_ALREADY_REVERSED' },
    });

    const lines = await db.query<{ direction: string; amount: string }>(
      `SELECT direction, amount::text FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY wallet_version`,
      [walletId],
    );
    expect(lines.rows).toEqual([
      { direction: 'CREDIT', amount: '100.00' },
      { direction: 'DEBIT', amount: '40.00' },
      { direction: 'CREDIT', amount: '15.00' },
      { direction: 'CREDIT', amount: '40.00' },
      { direction: 'DEBIT', amount: '15.00' },
    ]);
  });

  test('idempotency through nginx: replay keeps the historical balance; conflict on a changed payload', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const bet = wager(walletId, playerId, { money: { amount: '20.00', currency: 'BRL' } });
    expect((await submit(bet)).status).toBe(201);
    await submit(wager(walletId, playerId, { kind: 'WIN', money: { amount: '30.00', currency: 'BRL' } }));
    const replay = await submit(bet);
    expect(replay).toMatchObject({
      status: 200,
      body: { idempotentReplay: true, balance: { amount: '80.00' } },
    });
    expect((await submit({ ...bet, money: { amount: '21.00', currency: 'BRL' } })).status).toBe(409);
  });

  test('SQS path: the stack consumers process a message once, even when delivered twice', async () => {
    const { walletId, playerId } = await createWallet('50.00');
    const data = {
      ...wager(walletId, playerId, { money: { amount: '12.34', currency: 'BRL' } }),
      idempotencyKey: '',
    };
    data.idempotencyKey = `provider-e2e:${data.externalTransactionId}`;
    const messageId = uniqueId('e2e-msg');
    const body = JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data,
    });
    for (const copy of ['a', 'b']) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: `${QUEUE_BASE}/wager-transactions.fifo`,
          MessageBody: body,
          MessageGroupId: walletId,
          MessageDeduplicationId: `${messageId}-${copy}`,
        }),
      );
    }
    const settled = await waitFor(
      async () => {
        const response = await call<{ status: string }>(
          'GET',
          `/providers/provider-e2e/wagering/transactions/${data.externalTransactionId}`,
        );
        return response.status === 200 && response.body.status === 'PROCESSED' ? response.body : undefined;
      },
      { timeoutMs: 30_000, description: 'SQS transaction processed' },
    );
    expect(settled).toMatchObject({ status: 'PROCESSED', balance: { amount: '37.66' } });
    await waitFor(
      async () => {
        const inbox = await db.query(
          `SELECT 1 FROM inbox_messages WHERE message_id = $1 AND status = 'PROCESSED'`,
          [messageId],
        );
        return inbox.rowCount === 1;
      },
      { description: 'inbox row' },
    );
    await new Promise((resolve) => setTimeout(resolve, 3000)); // let the duplicate be consumed too
    const debits = await db.query(
      `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
      [walletId],
    );
    expect(debits.rowCount).toBe(1);
  });

  test('out-of-order REFUND is accepted (202) and settled by the reference worker once the BET arrives', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betId = uniqueId('late-bet');
    const refund = wager(walletId, playerId, {
      kind: 'REFUND',
      referenceExternalTransactionId: betId,
      money: { amount: '25.00', currency: 'BRL' },
    });
    const accepted = await submit(refund);
    expect(accepted.status).toBe(202);
    expect(
      (
        await submit(
          wager(walletId, playerId, {
            externalTransactionId: betId,
            money: { amount: '25.00', currency: 'BRL' },
          }),
        )
      ).status,
    ).toBe(201);
    const location = accepted.headers.get('location') ?? '';
    const settled = await waitFor(
      async () => {
        const response = await call<{ status: string }>('GET', location);
        return response.body.status === 'PROCESSED' ? response.body : undefined;
      },
      { timeoutMs: 30_000, description: 'refund settled by the worker' },
    );
    expect(settled).toMatchObject({ status: 'PROCESSED', referenceAttempts: 1 });
    expect((await call('GET', `/wallets/${walletId}`)).body).toMatchObject({
      balance: { amount: '100.00' },
      version: 3,
    });
  });

  test('committed events reach wager-events.fifo through the outbox workers', async () => {
    // Nothing consumes wager-events.fifo inside the stack, so it accumulates every event
    // ever published (e.g. by load tests). Purge it first so the search below is bounded.
    await sqs
      .send(new PurgeQueueCommand({ QueueUrl: `${QUEUE_BASE}/wager-events.fifo` }))
      .catch(() => undefined); // PurgeQueueInProgress: a purge ran less than 60s ago
    const { walletId, playerId } = await createWallet('10.00');
    await submit(wager(walletId, playerId, { money: { amount: '1.00', currency: 'BRL' } }));
    await waitFor(
      async () => {
        const pending = await db.query(
          `SELECT 1 FROM outbox_messages WHERE message_group_id = $1 AND status <> 'PUBLISHED'`,
          [walletId],
        );
        return pending.rowCount === 0;
      },
      { timeoutMs: 30_000, description: 'outbox published' },
    );
    const types = new Set<string>();
    await waitFor(
      async () => {
        const response = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: `${QUEUE_BASE}/wager-events.fifo`,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
          }),
        );
        for (const message of response.Messages ?? []) {
          const envelope = JSON.parse(message.Body ?? '{}') as {
            eventType: string;
            data: { walletId?: string };
          };
          if (envelope.data.walletId === walletId) types.add(envelope.eventType);
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: `${QUEUE_BASE}/wager-events.fifo`,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        }
        return types.size >= 2;
      },
      { timeoutMs: 30_000, description: 'events for the wallet' },
    );
    expect([...types].sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('two concurrent 80.00 bets on 100.00 through nginx: one 201, one 422, balance 20.00', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const responses = await Promise.all([
      submit(wager(walletId, playerId, { money: { amount: '80.00', currency: 'BRL' } })),
      submit(wager(walletId, playerId, { money: { amount: '80.00', currency: 'BRL' } })),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
    expect((await call('GET', `/wallets/${walletId}`)).body).toMatchObject({
      balance: { amount: '20.00' },
      version: 2,
    });
  });
});
