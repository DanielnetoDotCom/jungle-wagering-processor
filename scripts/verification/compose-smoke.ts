/** Run against a disposable Compose stack after `up --wait`. Creates test data. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const configuredUrl = process.env.CI_BASE_URL;
assert(configuredUrl, 'Set CI_BASE_URL explicitly to the disposable stack to verify');
const baseUrl = new URL(configuredUrl).origin;
const providerId = 'provider-ci-smoke';

interface Reply<T> {
  status: number;
  headers: Headers;
  body: T;
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<Reply<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, headers: response.headers, body: (await response.json()) as T };
}

async function main(): Promise<void> {
  const ready = await call('GET', '/health/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, 'ready');
  const instances = new Set<string>();
  for (let index = 0; index < 30; index += 1) {
    const live = await call('GET', '/health/live');
    assert.equal(live.status, 200);
    const instance = live.headers.get('x-instance-id');
    assert(instance, 'nginx must preserve X-Instance-Id');
    instances.add(instance);
  }
  assert(instances.size >= 3, `Expected at least three API replicas, found ${instances.size}`);

  const playerId = randomUUID();
  const opened = await call<{ id: string }>('POST', '/wallets', {
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  assert.equal(opened.status, 201);
  const walletId = opened.body.id;
  const wager = (kind: string, amount: string) => ({
    providerId,
    externalTransactionId: randomUUID(),
    walletId,
    playerId,
    roundId: 'ci-round',
    gameId: 'ci-game',
    kind,
    money: { amount, currency: 'BRL' },
  });
  const submit = (body: ReturnType<typeof wager>) =>
    call('POST', '/wagering/transactions', body, `${providerId}:${body.externalTransactionId}`);

  const bets = [wager('BET', '80.00'), wager('BET', '80.00')];
  const settled = await Promise.all(bets.map(submit));
  assert.deepEqual(settled.map((reply) => reply.status).sort(), [201, 422]);
  const winner = settled.findIndex((reply) => reply.status === 201);
  const winningBet = bets[winner];
  const winningReply = settled[winner];
  assert(winningBet && winningReply);
  assert.deepEqual(winningReply.body.balance, { amount: '20.00', currency: 'BRL' });

  assert.equal((await submit(wager('WIN', '10.00'))).status, 201);
  const replay = await submit(winningBet);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, { ...winningReply.body, idempotentReplay: true });
  assert.equal((await submit({ ...winningBet, money: { amount: '79.00', currency: 'BRL' } })).status, 409);

  const wallet = await call('GET', `/wallets/${walletId}`);
  assert.deepEqual(wallet.body.balance, { amount: '30.00', currency: 'BRL' });
  assert.equal(wallet.body.version, 3);
  const history = await call('GET', `/wagering/transactions/${String(winningReply.body.transactionId)}`);
  assert.deepEqual(history.body.balance, { amount: '20.00', currency: 'BRL' });
  const ledger = await call<{ items: unknown[] }>('GET', `/wallets/${walletId}/ledger?limit=200`);
  assert.equal(ledger.status, 200);
  assert.equal(ledger.body.items.length, 3); // OPENING, winning BET, WIN; no line for rejection or replay.
  const reconciliation = await call('POST', `/wallets/${walletId}/reconciliation`);
  assert.equal(reconciliation.status, 200);
  assert.equal(reconciliation.body.consistent, true);

  const report = {
    status: 'passed',
    // Persist the assertions that passed, rather than copying network payloads
    // into a file that another tool could later mistake for trusted input.
    checks: [
      'PostgreSQL and SQS readiness',
      'nginx reaches at least three API replicas',
      'two 80.00 bets on 100.00 settle as 201 and 422',
      'historical replay remains 20.00 BRL after a later WIN',
      'conflicting payload returns 409',
      'final balance is 30.00 BRL at version 3',
      'ledger contains exactly three entries',
      'wallet reconciliation is consistent',
    ],
  };
  await mkdir('reports', { recursive: true });
  await writeFile('reports/compose-smoke.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
