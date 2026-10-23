# Test report

Last run: **2026-10-23**, after the independent review (IR-01–IR-03 in [AUDIT_FIXES.md](AUDIT_FIXES.md#independent-review-of-the-2026-10-23-fixes)), Bun 1.4.3 in the `toolbox` container, real PostgreSQL **17.11** and LocalStack image **4.14.0**. Every suite creates its own databases and queues. Both commands exited 0: `docker compose --profile tools run --rm --build toolbox bun run verify` and `docker compose --profile tools run --rm toolbox bun run test:e2e`. Existing application services were not rebuilt or restarted in this review. The Compose/nginx smoke checks, demo, dependency audit and load results described elsewhere in this report are historical and were not repeated for this review. Details of causes, failing reproductions, fixes, requirement coverage and limits are in [AUDIT_FIXES.md](AUDIT_FIXES.md#independent-review-of-the-2026-10-23-fixes).

`bun run verify` runs, in order and failing on the first error: **ESLint** (`--max-warnings=0`, type-checked rules and layer boundaries) → **Prettier** (`--check`) → **typecheck** (`tsc --noEmit`, strict mode) → **`check:money`** → **build** (`tsc`) → **tests**.

## Results

| Suite | Command | Files | Tests | Result | Duration |
|---|---|---|---|---|---|
| Unit (domain, application, contracts, config, hash, fixtures and patches) | `bun run test:unit` | 13 | 161 | ✅ 161 pass | 0.36 s |
| Integration (real PostgreSQL + LocalStack) | `bun run test:integration` | 10 | 110 | ✅ 110 pass | 66.63 s |
| Concurrency (real parallelism, real processes) | `bun run test:concurrency` | 4 | 12 | ✅ 12 pass | 20.47 s |
| Fault injection (SIGKILL at exact points) | `bun run test:fault` | 1 | 5 | ✅ 5 pass | 27.62 s |
| **`bun run test` subtotal** | | **28** | **288** | ✅ **288 pass, 0 fail** | |
| E2E (compiled processes, dedicated database/queues) | `bun run test:e2e` | 1 | 7 | ✅ 7 pass | 6.82 s |
| Load (historical run, not repeated for this fix) | `bun run test:load` | — | — | 201 wallets reconciled, 0 inconsistencies | see LOAD_TEST.md |

Also verified in this run: `lint` ✅ (ESLint without warnings and Prettier), `typecheck` ✅, `check:money` ✅ (99 files), `build` ✅ (6 compiled entrypoints). **295 tests passed** including E2E. The toolbox Docker build used the frozen lockfile and existing patches. Earlier separate migration-image and full Compose smoke checks, and the two then-visible upstream `bun audit` alerts, are historical evidence; see [AUDIT_FIXES.md](AUDIT_FIXES.md).

## How the tests are isolated and realistic

- **Real infrastructure.** No integration test mocks PostgreSQL or SQS. Mocks appear only in the domain unit tests and, occasionally, as *failure doubles*: a publisher that fails on command and a use case that throws a transient error.
- **One database per test file** (`test/support/database.ts`): `CREATE DATABASE wagering_test_<label>_<random>`, real migrations run as owner, provisioning of the least-privilege login (as in production), and `DROP DATABASE … WITH (FORCE)` at the end. The services under test connect with the **runtime login**, not a superuser.
- **Dedicated queues per file** (`test/support/sqs.ts`), created with the same topology as production (FIFO, DLQ, redrive).
- **Real parallelism.** Concurrent promises use different pool connections (up to 50). The multi-instance scenarios start independent **operating system processes** (`Bun.spawn` of the same entrypoints as the containers), each with its own pool.
- **Real failures.** `FAULT_INJECTION=<point>=crash` makes the process kill itself with **SIGKILL** at the exact point: after the commit and before the ack, after publishing and before confirming, before the commit. No shutdown hook runs.
- **Controlled time.** Backoff, TTL and leases use `ManualClock`, with no long `sleep`.
- **Final invariant.** Every suite that writes ends with `expectAllWalletsConsistent()`, which computes in plain SQL (independently of the application code): balance = Σ ledger, version = last row, continuous chain, **ledger timestamps non-decreasing by version**, and no negative balance.

## Coverage of the challenge's required tests (§13)

### Unit

| Requirement | Where |
|---|---|
| Money: scale, rounding, invalid inputs | `unit/domain/money.test.ts`: 43 cases (NaN, Infinity, `1e3`, empty, whitespace, `25.5`, `25.001` without rounding, negatives, `+`, leading zeros, separators, 19-digit overflow, `0.10+0.20`, exactly 18 digits, `-0`, immutability, serialization) |
| Wallet invariants | `unit/domain/wallet.test.ts`: version 1 with OPENING, no entry for a zero balance, debit/credit with version +1, balance never negative, currency, overflow without changing state, `rehydrate` |
| BET, WIN, LOSS, REFUND, ROLLBACK rules | `unit/domain/wager-settlement.test.ts` (24) and `wager-transaction.test.ts` (18): state machine, terminal states, ROLLBACK direction, invalid references, double reversal, reversal without balance, LOSS with no effect, backoff/TTL |
| Currency conflict | `money.test.ts` (arithmetic/comparison), `wallet.test.ts`, `wager-settlement.test.ts` (`CURRENCY_MISMATCH`) |
| Idempotency key with a divergent payload | `unit/application/payload-hash.test.ts` (canonical hash, fixed vector, key order, metadata exclusion) + `integration/wager-processing.test.ts` (409) |

### Integration (real PostgreSQL and LocalStack)

| Requirement | Where |
|---|---|
| Migrations and constraints | `migrations.test.ts` (up, one-step down, full down, up again, no-op, grants) and `schema-guarantees.test.ts` (21 direct SQL tests: uniqueness, negative balance, version, append-only ledger for owner **and** runtime, arithmetic, chain, direction × type, ledger line tied to its transaction with the exact amount, PROCESSED transaction without ledger, immutable terminal state, idempotency keys, single reversal, reference validation, internal OPENING/provider, immutable inbox and outbox) |
| Atomicity across wallet, ledger, inbox and outbox | `wager-processing.test.ts` → `a failure after every write but before COMMIT leaves no partial state` (HTTP and SQS); `outbox.test.ts` → `events are never visible before the financial commit` |
| Inbox and redelivery | `sqs-consumer.test.ts` (same message 2×, HTTP then SQS, reused `messageId` → DLQ) and `wager-processing.test.ts` (HTTP→SQS, SQS→HTTP, `DUPLICATE_MESSAGE`) |
| Concurrent publishers on the same outbox | `outbox.test.ts` → `two concurrent publishers: disjoint claims (SKIP LOCKED), every event published exactly once` (60 events, `attempts = 1`) |
| Retry and DLQ | `sqs-consumer.test.ts` → transient error with backoff and a single success; DLQ by the consumer after `maxAttempts` real attempts, audited in the inbox; messages behind a failing FIFO group head keep their own budget (never sent to the DLQ without being processed); invalid messages go straight to the DLQ, audited in the inbox; a database outage longer than the retry budget **pauses** consumption without DLQ; 256-character `messageId` processed normally |
| Recovery after restart | `fault-injection/crash-recovery.test.ts` → `restart under load` and the other crashes |

### Concurrency (real parallelism)

| # | Challenge scenario | Test | Verified evidence |
|---|---|---|---|
| 1 | Same bet **50× in parallel** → one debit | `idempotency-burst.test.ts` (use case; HTTP across **3 API processes**; HTTP + SQS with **3 consumer processes**) | 1 RECORDED + 49 REPLAY, a single `transactionId`, one DEBIT row, expected balance, every replay with the original balance |
| 2 | 100.00 with two BETs of 80.00 | `same-wallet-race.test.ts` (25 wallets in parallel; 10 rounds across 3 distinct API processes; retries afterwards) | exactly 1 PROCESSED + 1 `REJECTED INSUFFICIENT_FUNDS`, balance **20.00**, version 2, **one** DEBIT, retries become replays with no new debit |
| 3 | Distinct wallets in parallel | `multi-instance-workload.test.ts` (30 wallets × 20 ops via 3 APIs + 3 consumers); `locks-and-deadlocks.test.ts` (`different wallets never block each other`) | each wallet's balance = independently computed decimal sum; version 21 |
| 4 | ≥ 3 processes/instances | the tests above and `hot wallet: 300 concurrent operations from 3 APIs + 3 consumers` | no spurious rejections; exact balance; lock contention observed in the metrics |
| 5 | Worker killed **after the commit and before the ack** | `crash-recovery.test.ts` → `consumer killed AFTER the commit and BEFORE the ack` | process killed with SIGKILL; inbox `PROCESSED`; message not deleted; a new consumer absorbs it (`inbox_duplicates = 1`); a single DEBIT |
| 6 | Two publishers on the same outbox | `outbox.test.ts` (in-process) and `crash-recovery.test.ts` → `outbox publisher killed AFTER publishing and BEFORE confirming` (real processes) | disjoint claims; after the crash, the lease expires and another publisher republishes (`attempts = 2`); all eventIds delivered |
| 7 | ROLLBACK/REFUND before the reference | `pending-references.test.ts` (6) and E2E | 202 → resolved when the BET arrives; backoff 2s/4s/8s/16s; `REFERENCE_NOT_FOUND` when attempts or the default TTL expire, including rejection delivery to SQS; ROLLBACK→REFUND→BET cascade; 8 concurrent REFUNDs → 1 applied |
| 8 | Service restart with eventual consistency | `crash-recovery.test.ts` → `restart under load: consumers SIGKILLed and SIGTERMed mid-stream` | 60 operations (with REFUND before BET) all `PROCESSED` once; 20 wallets with balance 102.50; empty DLQ |

Extras: a deterministically provoked deadlock, with PostgreSQL choosing the victim (`a provoked deadlock is detected by PostgreSQL, retried from scratch and applied exactly once`); `lock_timeout` with a retryable `503` error and nothing persisted; measured contention; **PostgreSQL actually unavailable** (`ALLOW_CONNECTIONS false` + terminated connections) → `503 DATABASE_UNAVAILABLE`, readiness 503, liveness 200 and automatic recovery.

### HTTP API (`http-api.test.ts`, 20 tests)

Contracts and status codes for every endpoint: uppercase UUIDs treated as the same wallet and the same operation, `201` + `Location`, `200` replay with an identical body and `Idempotent-Replayed`, `202` pending, `400` (payload, malformed JSON, missing `Idempotency-Key`, OPENING, unknown field, invalid amount, invalid cursor, `limit` > 200), `404`, `409`, `422` (with `failureCode`, `transactionId`, observed balance), `503`, `X-Correlation-Id` propagation, end-to-end keyset pagination (asc/desc), reconciliation, health and `/metrics`.

### E2E (`e2e/stack.test.ts`, 7 tests, isolated compiled processes)

Three APIs with distinct `X-Instance-Id`s, three consumers, two publishers and one reference worker, using a fresh database and randomly named queues. Every transaction type with ledger verification; idempotency across APIs; an SQS message delivered 2× (one effect); REFUND before BET resolved by the worker; events arriving in the suite's dedicated queue; two concurrent bets of 80.00 against a balance of 100.00. At the end, each wallet is reconciled and the suite's own resources are removed. There is no purge and no consumption of other parties' events. Nginx is checked separately in the full Compose smoke test.

### Audit regressions

`audit-regressions.test.ts` checks SQL with the runtime login against backfill (including four concurrent writers), multiple legitimate movements in the same commit, NaN, and post-commit metrics on rollback/retry/OPENING/reference worker. `migrations.test.ts` also covers upgrade/down/up with history and atomic refusal of pre-existing corruption. The new HTTP test covers the historical currency of a rejection on replay and in both GETs. `date-immutability.test.ts` covers mutation of input/output dates; `dependency-patches.test.ts` exercises the installed packages. `consumer-shutdown.test.ts` reproduced the missing release after the deadline expired and now verifies release of the whole batch, stopping of heartbeats, absence of a late ACK, and redelivery with a single financial effect.

## Defects found by the tests and fixed

1. **Long poll aborted on consumer shutdown.** When stopping, the consumer aborted the in-flight `ReceiveMessage`. If SQS had already responded, the messages stayed invisible and consumed an attempt without being processed, which sent messages to the DLQ prematurely. Detected in `sqs-consumer.test.ts`: the first processing already showed `receiveCount = 2`. Fix: do not abort the poll, and immediately release whatever arrives (ADR-010). The consumer tests dropped from ~6s to ~1s each.
2. **Timestamps taken before the lock.** The load test showed the outbox lag tracking HTTP latency. The operation instant was captured before acquiring the wallet lock, which allowed ledger entries with times out of version order. Fix: capture it after the lock. The invariant "timestamps non-decreasing by version" became part of the final audit of every suite.
3. **Unavailability classification.** "Database is not accepting connections" (`55000`) and "database does not exist" (`3D000`) were reported as internal errors (500). The real-unavailability test exposed this, and these cases are now `503 DATABASE_UNAVAILABLE`.
4. **Schema gap.** While writing the schema attacks, nothing prevented a `PROCESSED` transaction that moves money without a ledger entry. The deferred constraint trigger `wager_transactions_processed_has_ledger_entry` was added.

### Found in the final adversarial code review (and covered by new tests)

The initial review of the financial core found five cases in which **valid operations failed** or **transient errors became permanent**, fixed below. Later, the independent audit also reproduced a historical insertion that broke ledger consistency, plus other findings; the additional fixes and regressions are in [AUDIT_FIXES.md](AUDIT_FIXES.md). The results of this initial review should not be read as a guarantee that no other defects exist:

5. **A database outage exhausted the attempts.** During a ~30s outage the consumer kept receiving messages and sent the head of each FIFO group to the DLQ, which released the group's subsequent messages out of order. The consumer now pauses until the database responds. Test: `a database outage longer than the retry budget pauses consumption instead of dead-lettering`.
6. **A long `messageId` made the message unprocessable.** The correlation id derived from a `messageId` of 129 to 256 characters (valid per the contract) overflowed `varchar(128)` in the outbox. Now only a candidate that fits is used; otherwise a UUID is generated. Test with a 256-character `messageId`.
7. **Uppercase UUIDs** were accepted by validation but caused a 500 due to the spelling mismatch. They are now normalized in the contract. HTTP test with a lowercase replay.
8. **`DEAD_LETTERED` inbox row without a hash** (unreadable message) could not become `PROCESSED`, and an old hash could produce a spurious `MESSAGE_ID_CONFLICT`. The row now adopts the processed payload. Integration test plus unit test.
9. **Clock skew between instances** could violate `updated_at >= created_at`. `Wallet` now never dates a movement before the previous one. Unit test.
10. **Subsequent messages of a FIFO group went to the DLQ without being processed.** The attempt limit was `ApproximateReceiveCount` (SQS redrive). When a group head failed, the following messages in the same batch were received and deferred on every retry and exhausted the counter without a single attempt. Real failures are now counted in `inbox_attempts` and the consumer decides on the DLQ; the SQS redrive became a safety net. Test: `messages behind a failing FIFO group head keep their own budget` (two failing heads; the next one is processed with `receive_count > maxAttempts`).

### Found in the requirements-conformance audit (2026-10-23)

Each fix started with a test that reproduced the defect and failed.

11. **Database errors leaked personal data into the logs.** knex inlined the SQL bindings into driver error messages and MikroORM appended PostgreSQL's `detail` ("Failing row contains (…)"); `IntegrityViolationError` embedded that text and 500 responses logged it, so player ids, amounts and idempotency keys reached the logs. Errors are now translated into messages that name only the SQLSTATE and the constraint (`UnexpectedDatabaseError` for unmapped ones), and knex runs with `compileSqlOnError: false`. Test: `database errors never carry SQL bindings or row values into what gets logged` (bindings, ORM flush and an unmapped `22P02`).
12. **An outbox event could be republished forever.** `DEAD` was only set when a publication failed with a recorded outcome. A publication that kept killing its worker before the confirmation was re-claimed after every lease expiry, with no limit. Exhausted events whose last lease expired are now retained as `DEAD` before each claim (an operator requeue still gets a new attempt). Test: `a publication that keeps dying before its confirmation is retained as DEAD after max attempts, not republished forever`.
13. **The system provider id `internal` was accepted from providers** over HTTP and SQS, sharing the idempotency namespace of OPENING transactions. It is now rejected by the contract, the domain and a new constraint (`wager_tx_internal_provider_ck`). Tests at the contract, domain and schema levels.
14. **`GET /wagering/transactions/:id` ignored the provider scope** of the authentication extension point (latent with the no-op resolver). It now answers 404 for a transaction of another provider. Test: `a caller scoped to another provider gets 403 on its routes and 404 on a foreign transaction id`.
15. **The pending-reference TTL never applied.** With 10 attempts the retries ran out after ~18 minutes, before the 1h TTL. The attempt cap is now 20, so the TTL is the limit that applies. Test: `pending references: with the defaults the 1h TTL is the limit that applies, attempts are only a cap`.
16. **Tests that could pass without testing their claim.** The ledger chain test failed on another deferred trigger first and never reached `ledger_chain_continuity`; a `reference_attempts` test accepted any check violation; `waitFor` treated `null` as success; and `reconciliation`, `migrations` and the E2E suite did not run the final independent SQL audit. All now assert the exact constraint, and every suite that writes ends with `expectAllWalletsConsistent` (the reconciliation suite excludes only the wallets it corrupts on purpose).

New coverage without a defect behind it: replayed `422` and `202` status codes, reference mismatches on provider/wallet/currency, ROLLBACK of a ROLLBACK, `rehydrate` of transactions and ledger entries, the replay-or-conflict decision as a unit test, the configuration guard on the SQS redrive, and the outbox lag, processing duration, replay and DLQ metrics.

In addition, a flaky failure caused by the operating system handing out the same TCP port twice when starting 3 API processes in parallel, observed once, was eliminated in the test harness (port reservation and retry).

### Independent review (2026-10-23)

Three further P2 defects were reproduced with failing tests and fixed: a locked abandoned outbox row blocked unrelated publishers; successful late confirmation left delivered events DEAD; reconciliation alerts exposed exact balances. Retirement now uses bounded SKIP LOCKED batches with an independent claim-budget predicate, confirmation accepts known delivery after retirement, and alerts contain safe diagnostics. See [IR-01–IR-03](AUDIT_FIXES.md#additional-defects-reproduced-and-fixed) for files, causes, RED/GREEN evidence and remaining limits.

Additional coverage proves exhausted backlogs never get an extra claim, operator requeue preserves attempt history, default TTL rejection reaches real SQS, persisted consumer failures survive SIGKILL, null results keep polling, and an injected scoped identity can read its own transaction while foreign/missing ids return 404. No dependency or applied migration was changed; no integration/concurrency test was weakened or disabled.

## What was not validated here

- **Development on the host** (`bun run dev` outside Docker with `docker-compose.dev.yml`): Bun was not installed on the validation host. The same scripts were run inside containers.
- **Native Linux**: validated on Docker Desktop/WSL2 (Linux kernel 6.6). There was no run on a Linux host without Docker Desktop.
- **Real SQS (AWS)**: LocalStack 4.14 only.
