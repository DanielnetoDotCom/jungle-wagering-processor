/**
 * Load test against the running compose stack (`bun run test:load`):
 *   docker compose up -d --build
 *   docker compose --profile tools run --rm toolbox bun run test:load
 *
 * Workload (concurrently, for LOAD_DURATION_SECONDS):
 *  - LOAD_CONCURRENCY virtual users over HTTP (nginx -> 3 API replicas):
 *    BET/WIN on many wallets, a share on ONE hot wallet, and identical
 *    retries of earlier requests (idempotent replays);
 *  - an SQS producer (LOAD_SQS_RATE msg/s) consumed by the 3 consumers,
 *    including duplicated deliveries of the same message.
 * Then waits for queues/outbox to drain and reconciles EVERY wallet.
 * Numbers are measured, never assumed; the JSON report goes to reports/.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';

const BASE_URL = process.env.DEMO_BASE_URL ?? process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const DURATION_S = Number(process.env.LOAD_DURATION_SECONDS ?? '60');
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? '32');
const WALLETS = Number(process.env.LOAD_WALLETS ?? '200');
const SQS_RATE = Number(process.env.LOAD_SQS_RATE ?? '50');
const HOT_SHARE = Number(process.env.LOAD_HOT_WALLET_SHARE ?? '0.15');
const REPLAY_SHARE = Number(process.env.LOAD_REPLAY_SHARE ?? '0.10');
const PROVIDER = 'provider-load';
const QUEUE_URL = `${process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566'}/000000000000/${process.env.SQS_TRANSACTIONS_QUEUE ?? 'wager-transactions.fifo'}`;

interface Wallet {
  walletId: string;
  playerId: string;
}

interface Sample {
  ms: number;
  status: number;
  kind: 'new' | 'replay';
  hot: boolean;
}

const samples: Sample[] = [];
const sentBodies: Array<{ body: Record<string, unknown>; key: string }> = [];
/** externalTransactionId -> epoch ms when the SQS message was sent (end-to-end latency). */
const sqsSentAt = new Map<string, number>();

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round((sorted[index] ?? 0) * 100) / 100;
}

function cents(): string {
  return `${randomInt(1, 20)}.${String(randomInt(0, 100)).padStart(2, '0')}`;
}

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function createWallet(amount: string): Promise<Wallet> {
  const playerId = randomUUID();
  const response = await post('/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  if (response.status !== 201) throw new Error(`wallet creation failed: ${response.status}`);
  return { walletId: String(response.json.id), playerId };
}

function operation(wallet: Wallet): Record<string, unknown> {
  return {
    providerId: PROVIDER,
    externalTransactionId: `load-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: `round-${randomInt(1_000_000)}`,
    gameId: 'fortune-chimp',
    kind: randomInt(10) < 6 ? 'BET' : 'WIN',
    money: { amount: cents(), currency: 'BRL' },
  };
}

/** Sums one counter family over every replica of a service (Docker DNS returns one A record per replica). */
async function scrape(service: string, port: number, metric: RegExp): Promise<number> {
  const addresses = await lookup(service, { all: true }).catch(() => []);
  let total = 0;
  for (const { address } of addresses) {
    const text = await fetch(`http://${address}:${port}/metrics`)
      .then((response) => response.text())
      .catch(() => '');
    for (const line of text.split('\n')) {
      if (!line.startsWith('#') && metric.test(line))
        total += Number(line.slice(line.lastIndexOf(' ') + 1)) || 0;
    }
  }
  return total;
}

async function counters(): Promise<Record<string, number>> {
  const sum = async (pattern: RegExp) =>
    (await scrape('api', 3000, pattern)) +
    (await scrape('consumer', 9100, pattern)) +
    (await scrape('reference-worker', 9100, pattern));
  return {
    lockContention: await sum(/^wagering_wallet_lock_contention_total/),
    dbRetries: await sum(/^wagering_db_retries_total/),
    deadlocks: await sum(/^wagering_deadlocks_total/),
    lockTimeouts: await sum(/^wagering_lock_timeouts_total/),
    idempotentReplays: await sum(/^wagering_idempotent_replays_total/),
    inboxDuplicates: await sum(/^wagering_inbox_duplicates_total/),
    sqsRetries: await sum(/^wagering_sqs_message_retries_total/),
    sqsDeadLettered: await sum(/^wagering_sqs_messages_dead_lettered_total/),
  };
}

async function virtualUser(wallets: Wallet[], hot: Wallet, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    const replay = sentBodies.length > 0 && Math.random() < REPLAY_SHARE;
    const isHot = !replay && Math.random() < HOT_SHARE;
    let body: Record<string, unknown>;
    let key: string;
    if (replay) {
      const previous = sentBodies[randomInt(sentBodies.length)]!;
      body = previous.body;
      key = previous.key;
    } else {
      body = operation(isHot ? hot : wallets[randomInt(wallets.length)]!);
      key = `${PROVIDER}:${String(body.externalTransactionId)}`;
      if (sentBodies.length < 5000) sentBodies.push({ body, key });
    }
    const started = performance.now();
    let status: number;
    try {
      status = (await post('/wagering/transactions', body, { 'Idempotency-Key': key })).status;
    } catch {
      status = 0;
    }
    samples.push({ ms: performance.now() - started, status, kind: replay ? 'replay' : 'new', hot: isHot });
  }
}

async function sqsProducer(
  sqs: SQSClient,
  wallets: Wallet[],
  deadline: number,
): Promise<{ sent: number; duplicates: number }> {
  let sent = 0;
  let duplicates = 0;
  const intervalMs = 200;
  const perTick = Math.max(1, Math.round((SQS_RATE * intervalMs) / 1000));
  while (Date.now() < deadline) {
    const entries: Array<{
      Id: string;
      MessageBody: string;
      MessageGroupId: string;
      MessageDeduplicationId: string;
    }> = [];
    const capacity = Math.min(perTick, 10); // SQS batch limit
    while (entries.length < capacity) {
      const wallet = wallets[randomInt(wallets.length)]!;
      const data = operation(wallet);
      const body = JSON.stringify({
        messageId: `load-msg-${randomUUID()}`,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...data, idempotencyKey: `${PROVIDER}:${String(data.externalTransactionId)}` },
      });
      const entry = { MessageBody: body, MessageGroupId: wallet.walletId };
      entries.push({ ...entry, Id: `e${entries.length}`, MessageDeduplicationId: randomUUID() });
      // ~10% of the messages are delivered twice (same messageId, different SQS dedup id).
      if (randomInt(10) === 0 && entries.length < capacity) {
        entries.push({ ...entry, Id: `e${entries.length}`, MessageDeduplicationId: randomUUID() });
        duplicates += 1;
      }
    }
    const sentAt = Date.now();
    await sqs.send(new SendMessageBatchCommand({ QueueUrl: QUEUE_URL, Entries: entries }));
    for (const entry of entries) {
      const externalId = (JSON.parse(entry.MessageBody) as { data: { externalTransactionId: string } }).data
        .externalTransactionId;
      if (!sqsSentAt.has(externalId)) sqsSentAt.set(externalId, sentAt);
    }
    sent += entries.length;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { sent, duplicates };
}

async function main(): Promise<void> {
  const db = new Pool({
    host: process.env.TEST_DB_HOST ?? 'postgres',
    user: process.env.TEST_DB_ADMIN_USER,
    password: process.env.TEST_DB_ADMIN_PASSWORD,
    database: process.env.E2E_DB_NAME ?? 'wagering',
    max: 4,
  });
  const sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  console.log(`Setup: ${WALLETS} wallets + 1 hot wallet ...`);
  const wallets: Wallet[] = [];
  for (let index = 0; index < WALLETS; index += 10) {
    wallets.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(10, WALLETS - index) }, () => createWallet('100000.00')),
      )),
    );
  }
  const hot = await createWallet('1000000.00');
  const before = await counters();
  const startedAt = new Date();

  console.log(`Load: ${DURATION_S}s, ${CONCURRENCY} HTTP virtual users, SQS ${SQS_RATE} msg/s ...`);
  const deadline = Date.now() + DURATION_S * 1000;
  const loadStarted = performance.now();
  const [, sqsResult] = await Promise.all([
    Promise.all(Array.from({ length: CONCURRENCY }, () => virtualUser(wallets, hot, deadline))),
    sqsProducer(sqs, wallets, deadline),
  ]);
  const httpSeconds = (performance.now() - loadStarted) / 1000;

  console.log('Draining: SQS consumers, outbox publishers, pending references ...');
  const drainStarted = performance.now();
  for (;;) {
    const row = await db.query<{ pending_outbox: number; pending_refs: number }>(
      `SELECT (SELECT count(*)::int FROM outbox_messages WHERE status = 'PENDING') AS pending_outbox,
              (SELECT count(*)::int FROM wager_transactions WHERE status = 'PENDING_REFERENCE') AS pending_refs`,
    );
    const inbox = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM inbox_messages WHERE received_at >= $1`,
      [startedAt],
    );
    const expectedMessageIds = sqsResult.sent - sqsResult.duplicates;
    if (
      row.rows[0]?.pending_outbox === 0 &&
      row.rows[0]?.pending_refs === 0 &&
      (inbox.rows[0]?.count ?? 0) >= expectedMessageIds
    )
      break;
    if (performance.now() - drainStarted > 300_000) throw new Error('drain timed out');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const drainSeconds = (performance.now() - drainStarted) / 1000;
  const after = await counters();

  const outboxLag = await db.query<{ p50: number; p95: number; p99: number; max: number; events: number }>(
    `SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY lag) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY lag) AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY lag) AS p99,
            max(lag) AS max, count(*)::int AS events
       FROM (SELECT extract(epoch FROM published_at - occurred_at) * 1000 AS lag
               FROM outbox_messages WHERE occurred_at >= $1 AND status = 'PUBLISHED') lags`,
    [startedAt],
  );
  // SQS end-to-end: producer send -> transaction committed by a consumer.
  const sqsRows = await db.query<{ external_transaction_id: string; committed_ms: string }>(
    `SELECT external_transaction_id, (extract(epoch FROM created_at) * 1000)::bigint::text AS committed_ms
       FROM wager_transactions WHERE channel = 'SQS' AND created_at >= $1`,
    [startedAt],
  );
  const sqsEndToEnd = sqsRows.rows
    .map(
      (row) =>
        BigInt(row.committed_ms) -
        BigInt(sqsSentAt.get(row.external_transaction_id) ?? Number(row.committed_ms)),
    )
    .map((delta) => Number(delta))
    .sort((a, b) => a - b);
  const sqsLatency = {
    rows: [
      {
        processed: sqsEndToEnd.length,
        p50: percentile(sqsEndToEnd, 50),
        p95: percentile(sqsEndToEnd, 95),
        p99: percentile(sqsEndToEnd, 99),
      },
    ],
  };

  console.log('Reconciling every wallet through the API ...');
  let inconsistent = 0;
  for (const wallet of [...wallets, hot]) {
    const report = await post(`/wallets/${wallet.walletId}/reconciliation`, {});
    if (report.json.consistent !== true) inconsistent += 1;
  }
  const negative = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM wallets WHERE balance_amount < 0`,
  );
  const hotVersion = await db.query<{ version: number }>(`SELECT version FROM wallets WHERE id = $1`, [
    hot.walletId,
  ]);

  const latencies = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const hotLatencies = samples
    .filter((sample) => sample.hot)
    .map((sample) => sample.ms)
    .sort((a, b) => a - b);
  const byStatus = samples.reduce<Record<string, number>>((acc, sample) => {
    acc[String(sample.status)] = (acc[String(sample.status)] ?? 0) + 1;
    return acc;
  }, {});
  const errors = samples.filter((sample) => sample.status === 0 || sample.status >= 500).length;
  const delta = Object.fromEntries(
    Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]),
  );

  const report = {
    environment: {
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model,
      memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      bun: Bun.version,
      startedAt: startedAt.toISOString(),
    },
    parameters: { DURATION_S, CONCURRENCY, WALLETS, SQS_RATE, HOT_SHARE, REPLAY_SHARE },
    http: {
      requests: samples.length,
      seconds: Math.round(httpSeconds * 10) / 10,
      rps: Math.round((samples.length / httpSeconds) * 10) / 10,
      latencyMs: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: percentile(latencies, 100),
      },
      hotWalletLatencyMs: {
        p50: percentile(hotLatencies, 50),
        p95: percentile(hotLatencies, 95),
        p99: percentile(hotLatencies, 99),
      },
      byStatus,
      errorRate: samples.length ? Math.round((errors / samples.length) * 10000) / 100 : 0,
      replaysSent: samples.filter((sample) => sample.kind === 'replay').length,
      hotWalletRequests: hotLatencies.length,
    },
    sqs: {
      messagesSent: sqsResult.sent,
      duplicateDeliveriesSent: sqsResult.duplicates,
      processingLatencyMs: sqsLatency.rows[0],
      drainSeconds: Math.round(drainSeconds * 10) / 10,
    },
    outboxPublishLagMs: outboxLag.rows[0],
    concurrency: delta,
    consistency: {
      walletsReconciled: wallets.length + 1,
      inconsistent,
      negativeBalances: negative.rows[0]?.count ?? 0,
      hotWalletVersion: hotVersion.rows[0]?.version,
    },
  };

  mkdirSync('reports', { recursive: true });
  const file = `reports/load-test-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${file}`);
  await db.end();
  sqs.destroy();
  if (inconsistent > 0 || report.consistency.negativeBalances > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
