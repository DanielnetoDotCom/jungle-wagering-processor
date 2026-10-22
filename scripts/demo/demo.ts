/**
 * Guided tour of the running stack (`bun run demo`):
 *   docker compose up -d --build
 *   docker compose --profile tools run --rm toolbox bun run demo
 *
 * Every step prints the HTTP status and the relevant fields, so the output
 * doubles as executable documentation of the API contract.
 */
import { randomUUID } from 'node:crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const BASE_URL = process.env.DEMO_BASE_URL ?? 'http://localhost:8080';
const SQS_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const QUEUE_URL = `${SQS_ENDPOINT}/000000000000/${process.env.SQS_TRANSACTIONS_QUEUE ?? 'wager-transactions.fifo'}`;
const PROVIDER = 'provider-demo';

type Json = Record<string, unknown>;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : {}) as Json };
}

function step(title: string): void {
  console.log(`\n=== ${title}`);
}

function show(label: string, response: { status: number; body: Json }, fields: string[]): void {
  const picked = Object.fromEntries(
    fields.filter((field) => field in response.body).map((field) => [field, response.body[field]]),
  );
  console.log(`${label.padEnd(44)} -> ${response.status} ${JSON.stringify(picked)}`);
}

async function waitForStatus(path: string, status: string): Promise<Json> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await call('GET', path);
    if (response.status === 200 && response.body.status === status) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${path} did not reach ${status}`);
}

async function main(): Promise<void> {
  step('Health and load balancing (3 API replicas behind nginx)');
  show('GET /health/ready', await call('GET', '/health/ready'), ['status', 'checks']);
  const instances = new Set<string>();
  for (let index = 0; index < 12; index += 1) {
    instances.add((await fetch(`${BASE_URL}/health/live`)).headers.get('x-instance-id') ?? '?');
  }
  console.log(`instances answering /health/live: ${[...instances].join(', ')}`);

  step('Wallet');
  const playerId = randomUUID();
  const wallet = await call('POST', '/wallets', {
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  show('POST /wallets (100.00 BRL)', wallet, ['id', 'balance', 'version']);
  const walletId = String(wallet.body.id);
  show(
    'POST /wallets (same player again)',
    await call('POST', '/wallets', { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } }),
    ['code', 'details'],
  );

  const tx = (kind: string, amount: string, extra: Json = {}) => ({
    providerId: PROVIDER,
    externalTransactionId: `demo-${randomUUID()}`,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  });
  const submit = (body: Json, key = `${PROVIDER}:${String(body.externalTransactionId)}`) =>
    call('POST', '/wagering/transactions', body, { 'Idempotency-Key': key });
  const fields = ['status', 'balance', 'walletVersion', 'idempotentReplay', 'code', 'failureCode'];

  step('BET + idempotency');
  const bet = tx('BET', '25.00');
  show('BET 25.00', await submit(bet), fields);
  show('same BET again (replay)', await submit(bet), fields);
  show(
    'same key, amount 26.00 (conflict)',
    await submit({ ...bet, money: { amount: '26.00', currency: 'BRL' } }),
    ['code', 'retryable'],
  );
  show('BET 500.00 (insufficient funds)', await submit(tx('BET', '500.00')), fields);
  show('BET 1.001 (invalid money)', await submit(tx('BET', '1.001')), ['code', 'retryable']);

  step('WIN, LOSS, REFUND, ROLLBACK');
  const win = tx('WIN', '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
  show('WIN 10.00 (ref BET)', await submit(win), fields);
  show(
    'LOSS 0.00 (ref BET, no money moves)',
    await submit(tx('LOSS', '0.00', { referenceExternalTransactionId: bet.externalTransactionId })),
    fields,
  );
  show(
    'REFUND 25.00 (ref BET)',
    await submit(tx('REFUND', '25.00', { referenceExternalTransactionId: bet.externalTransactionId })),
    fields,
  );
  show(
    'ROLLBACK 25.00 (same BET again)',
    await submit(tx('ROLLBACK', '25.00', { referenceExternalTransactionId: bet.externalTransactionId })),
    fields,
  );
  show(
    'ROLLBACK 10.00 (ref WIN)',
    await submit(tx('ROLLBACK', '10.00', { referenceExternalTransactionId: win.externalTransactionId })),
    fields,
  );

  step('Out-of-order: REFUND before its BET');
  const lateBetId = `demo-${randomUUID()}`;
  const early = await submit(
    tx('REFUND', '5.00', { referenceExternalTransactionId: lateBetId, roundId: 'round-2' }),
  );
  show('REFUND 5.00 (BET not seen yet)', early, ['status', 'nextAttemptAt']);
  show(
    'BET 5.00 arrives',
    await submit(tx('BET', '5.00', { externalTransactionId: lateBetId, roundId: 'round-2' })),
    fields,
  );
  const settled = await waitForStatus(early.headers.get('location') ?? '', 'PROCESSED');
  console.log(
    `${'REFUND after the reference worker'.padEnd(44)} -> ${JSON.stringify({ status: settled.status, referenceAttempts: settled.referenceAttempts })}`,
  );

  step('SQS: same use case, inbox deduplication');
  const sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: SQS_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  const sqsBet = tx('BET', '7.50');
  const message = JSON.stringify({
    messageId: `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...sqsBet, idempotencyKey: `${PROVIDER}:${String(sqsBet.externalTransactionId)}` },
  });
  for (const copy of ['first', 'duplicate']) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: message,
        MessageGroupId: walletId,
        MessageDeduplicationId: `${copy}-${randomUUID()}`,
      }),
    );
  }
  const viaSqs = await waitForStatus(
    `/providers/${PROVIDER}/wagering/transactions/${String(sqsBet.externalTransactionId)}`,
    'PROCESSED',
  );
  console.log(
    `${'BET 7.50 sent twice via SQS'.padEnd(44)} -> ${JSON.stringify({ status: viaSqs.status, balance: viaSqs.balance })}`,
  );
  sqs.destroy();

  step('Ledger, wallet and reconciliation');
  const page = await call('GET', `/wallets/${walletId}/ledger?limit=3`);
  const items = page.body.items as Array<{
    direction: string;
    money: { amount: string };
    walletVersion: number;
  }>;
  console.log(
    `GET /wallets/:id/ledger?limit=3 -> ${items.map((item) => `v${item.walletVersion} ${item.direction} ${item.money.amount}`).join(' | ')}; nextCursor=${page.body.nextCursor ? 'yes' : 'no'}`,
  );
  show('GET /wallets/:id', await call('GET', `/wallets/${walletId}`), ['balance', 'version']);
  show('POST /wallets/:id/reconciliation', await call('POST', `/wallets/${walletId}/reconciliation`), [
    'storedBalance',
    'calculatedBalance',
    'difference',
    'consistent',
    'checkedEntries',
  ]);
  console.log(`\nDemo wallet: ${walletId}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
