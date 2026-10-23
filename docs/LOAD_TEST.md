# Load test

> Measured numbers, not estimates. The raw JSON reports live in `reports/` (ignored by Git) and are regenerated on every run. There is no RPS target: the goal is to show how the system behaves under real concurrency and whether the financial invariants still hold at the end.

## Environment

| Item | Value |
|---|---|
| Host | Windows 11 Pro, Intel Core i5-12400 (6 cores / 12 threads), 31.8 GB RAM |
| Docker | Docker Desktop 29.7.2 (WSL2 backend, kernel 6.6.87.2), 12 vCPUs and 15.5 GB available to the containers |
| Topology | `docker compose up -d --build`: nginx + **3 api** + **3 consumer** + **2 outbox-worker** + 1 reference-worker + PostgreSQL 17 + LocalStack 4.14 (SQS) |
| Runtime | Bun 1.4.3, compiled code (`tsc`), `NODE_ENV=production` |
| PostgreSQL pools | api 10 connections × 3, consumer 5 × 3, outbox 3 × 2, reference 3 (54 total) |
| Load generator | `toolbox` (same host, internal Docker network), Bun `fetch` client with keep-alive |

All components, including the load generator, compete for the same CPU. This is a development environment, not a production benchmark (see "Experiment limitations").

The runs took place before the final code review fixes ([TEST_REPORT.md](TEST_REPORT.md), items 5 to 9): consumer pause during a database outage, bounded correlation id, UUID normalization, inbox for a never-processed message, and monotonic timestamps. None of them acts on the measured failure-free path, so the numbers remain representative. To re-measure: `bun run test:load`.

## Methodology

Command (reproducible):

```bash
docker compose up -d --build
docker compose --profile tools run --rm toolbox bun run test:load
# variations via environment variables, for example:
docker compose --profile tools run --rm -e LOAD_HOT_WALLET_SHARE=0 toolbox bun run test:load
```

Script: [`scripts/load-test/load-test.ts`](../scripts/load-test/load-test.ts).

1. **Setup**: creates 200 wallets with a balance of 100,000.00 BRL and 1 *hot wallet* with 1,000,000.00 BRL (a high balance so that no bet is rejected for insufficient funds and the expected result is deterministic).
2. **Load for 60s, simultaneously**:
   - **HTTP**: 32 virtual users in a closed loop against nginx (port 8080 → 3 replicas). Each iteration is a BET (60%) or WIN (40%) of 1.00 to 19.99 BRL. By default 15% of operations go to the hot wallet and 10% are **identical resends** of earlier requests (same `Idempotency-Key`, same payload).
   - **SQS**: a producer sending ~50 msg/s to `wager-transactions.fifo` (`MessageGroupId` = walletId). About 10% of messages are **delivered twice** (same `messageId`, different `MessageDeduplicationId`), forcing deduplication by the inbox.
3. **Drain**: waits until the outbox has no `PENDING` events, no `PENDING_REFERENCE` remains, and the inbox has recorded every unique message.
4. **Collection**:
   - HTTP latency (p50/p95/p99/max) measured on the client;
   - end-to-end SQS latency: send by the producer → `created_at` of the transaction written by the consumer;
   - outbox lag: `published_at − occurred_at` for each event (percentiles computed in PostgreSQL);
   - Prometheus counters summed across **all** replicas (Docker DNS → one IP per replica): lock contention, retries, deadlocks, lock timeouts, replays and inbox duplicates.
5. **Final verification**: `POST /wallets/:id/reconciliation` for **all** 201 wallets, plus a check for negative balances in the database.

## Results

Three 60s runs with the same parameters, except where noted:

| Metric | A: hot 15% (before the timestamp fix) | **B: hot 15% (final version)** | C: no hot wallet |
|---|---|---|---|
| HTTP requests | 17,191 | **15,808** | 20,288 |
| HTTP throughput | 285.2 req/s | **262.2 req/s** | 337.6 req/s |
| HTTP latency p50 / p95 / p99 | 42 / 551 / 767 ms | **48 / 616 / 863 ms** | 86 / 184 / 239 ms |
| Max HTTP latency | 1,797 ms | **1,867 ms** | 403 ms |
| Hot wallet p50 / p95 / p99 | 488 / 803 / 1,125 ms | **535 / 903 / 1,117 ms** | — |
| Operations on the hot wallet | 2,367 | **2,098** | 0 |
| HTTP status | 201: 15,509, 200: 1,682 | **201: 14,118, 200: 1,690** | 201: 18,314, 200: 1,974 |
| Error rate (5xx / network) | 0% | **0%** | 0% |
| SQS messages sent (duplicates) | 2,760 (221) | **2,740 (242)** | 2,670 (213) |
| SQS end-to-end p50 / p95 / p99 | 32 / 119 / 224 ms | **46 / 160 / 420 ms** | 52 / 146 / 240 ms |
| Outbox lag p50 / p95 / p99 / max | 97 / 571 / 802 / 1,915 ms | **90 / 219 / 421 / 587 ms** | 165 / 506 / 826 / 1,021 ms |
| Events published | 36,096 | **33,232** | 41,542 |
| Wallet lock waits (contention) | 3,097 | **2,867** | 2,126 |
| Transaction retries / deadlocks / lock timeouts | 0 / 0 / 0 | **0 / 0 / 0** | 0 / 0 / 0 |
| Idempotent replays (HTTP) | 1,682 | **1,690** | 1,974 |
| Duplicates absorbed by the inbox | 221 | **242** | 213 |
| SQS retries / messages in the DLQ | 0 / 0 | **0 / 0** | 0 / 0 |
| Wallets reconciled / inconsistent | 201 / 0 | **201 / 0** | 201 / 0 |
| Negative balances | 0 | **0** | 0 |

In every run:

- **No divergence** between the materialized balance and the ledger, across 201 wallets.
- Every HTTP replay returned `200` with the original result. The number of replays measured by the server is **exactly** equal to the number of client resends (1,690 = 1,690 in run B).
- Every SQS duplicate was absorbed by the inbox: 242 sent, 242 counted in `wagering_inbox_duplicates_total`.
- The final version of the hot wallet equals the number of applied operations plus the OPENING (2,099 = 2,098 + 1): no operation was applied twice.

## Analysis

### 1. Hot wallet: the cost of pessimistic locking is localized and measurable

Every change to a wallet is serialized by `SELECT … FOR UPDATE` on its row. With ~15% of 32 virtual users (~5 on average) contending for the same wallet, each request waits, at the median, for the previous ones to commit (p50 of 535ms on the hot wallet). This is the intended behavior: correctness before throughput. The side effect shows up in the B vs. C comparison:

- Without the hot wallet, the overall p95 drops from 616ms to 184ms and the p99 from 863ms to 239ms.
- The cause is that **whoever waits for the lock holds a pool connection** while waiting. Hot wallet requests occupy part of the APIs' 30 connections, and requests for other wallets end up waiting for a connection. The hot wallet does not block other wallets in the database (there is no global lock; the `different wallets never block each other` test proves it), but it competes with them for a shared process resource.
- The lower p50 in run B (48ms vs. 86ms in C) does not mean B is faster. In B some users are "parked" on the hot wallet, and the rest find the database less busy.

Possible mitigations, not implemented because they do not improve correctness: (a) an in-memory per-wallet queue inside each instance (*single-flight*), which reduces idle connections without replacing the database lock; (b) a dedicated pool or a lower `lock_timeout` for known hot wallets, returning `503 LOCK_TIMEOUT` (retryable) sooner; (c) partitioning the balance of institutional wallets into sub-wallets. See ADR-005 in [ARCHITECTURE.md](../ARCHITECTURE.md).

### 2. No retries, deadlocks or lock timeouts

With a single wallet per operation and a fixed lock order (wallet → transaction → other rows), no deadlocks occurred under load. Deadlock recovery is tested separately and deterministically (`test/concurrency/locks-and-deadlocks.test.ts`). The 5s `lock_timeout` was never reached; the highest observed HTTP latency, which includes waiting for the lock, was about 1.9s.

### 3. Outbox lag and a fix made because of this test

In run A, the outbox lag (p95 571ms) tracked the HTTP latency. Investigation showed that the operation instant (`occurred_at`, `processed_at`, the ledger's `created_at`) was captured **before** acquiring the wallet lock, and therefore included the wait time. Besides skewing the lag, this allowed version N+1 of a wallet to have an earlier timestamp than version N.

The fix now captures the instant **after** the lock (`process-wager-transaction.use-case.ts` and `resolve-pending-reference.use-case.ts`). I also added to the whole test suite a check that the ledger's `created_at` is non-decreasing by version. In run B, the lag now actually measures commit → publish: p95 219ms, max 587ms.

In run C (more events per second: 692/s vs. 554/s in B) the lag rises again (p95 506ms). This indicates that 2 publishers with batches of 50 events and sequential `SendMessageBatch` sends are close to capacity in this environment. It is tunable via `OUTBOX_BATCH_SIZE`, `OUTBOX_POLL_INTERVAL_MS` and `outbox-worker` replicas (the `SKIP LOCKED` claim scales horizontally).

### 4. SQS

The consumers kept up with ~46 msg/s with no queue buildup (drain ≤ 1s after the load ended), with an end-to-end p95 of 146 to 160ms. There were no retries and no DLQ messages.

## Experiment limitations

- A single host runs all the components **and** the load generator: the numbers reflect CPU contention among them, not the limit of any isolated component.
- Docker Desktop on Windows (WSL2) adds virtual network latency between containers. On native Linux the numbers tend to be better.
- LocalStack does not reproduce the latency, limits or throttling of real SQS.
- PostgreSQL with the default configuration (except `max_connections=200`, `shared_buffers=256MB`), on a Docker volume.
- 60s runs do not show long-term effects (table growth, autovacuum, outbox/inbox retention).
- Closed-loop load: the arrival rate adapts to latency and does not test overload at a fixed rate (*open model*).
