# Audit fixes — 2026-10-22

The changes below fix the reproduced audit findings. They were implemented in the repository and validated on disposable infrastructure; the new migration was not applied to the pre-existing stack.

| Finding | Fix | Regression |
|---|---|---|
| F01 — replay/GET currency | The mapper rebuilds the historical balance in the wallet's immutable currency, including for already stored rejections. The currency requested by the transaction is still preserved. | `http-api.test.ts`: USD BET against a BRL wallet; the first response, a replay after another movement, and both queries keep the original balance in BRL. |
| F02 — retroactive ledger insertion | Additive migration `20261022000500`: validates the predecessor, successor, initial/OPENING position and materialized tail; serializes the validation with a lock on the wallet. Allows several legitimate movements in the same commit and a zero opening. | `audit-regressions.test.ts`: SQL with the runtime login, isolated backfill and four concurrent attempts rejected; two movements in the same commit accepted. |
| F03 — NaN in the schema | Additional CHECKs restrict every monetary column to the finite range of `NUMERIC(20,2)`. The previous non-negativity rules remain. | SQL with the runtime login rejects NaN in the wallet balance, the transaction amount and snapshot, and ledger values, including the case where all the arithmetic involves NaN. |
| F04 — metrics before COMMIT | Synchronous `afterCommit` observations per unit of work; callbacks discarded on rollback/retry. A metric or logger failure does not turn a successful commit into a financial error. | HTTP/SQS rollback, retry, OPENING, reference resolution, and deferred failure at COMMIT. A failing observer does not prevent the committed result or the other observers. |
| F05 — destructive purge in E2E | E2E creates a dedicated database and queues and starts the compiled entrypoints in their own processes. Removed `PurgeQueue`, fixed queue URLs, and selection of an external database/API. Cleanup restricted to the resources created by the suite. | Seven E2E tests; additional check with a financial table and a sentinel message outside the suite, described below. |
| F06 — dependencies | AJV 8.20.0, ESLint 10.13.0, typescript-eslint 8.72.0, the maintained Prometheus client `@prometheus-io/client` 0.16.1, and umzug 3.8.3. Migrator loaded dynamically and separated from the APIs/workers image. Local patches for the two advisories that still have no fixed release. | Frozen install, lint/typecheck/build, real migrations, `/metrics`, and patch regressions on the dependencies actually installed. |
| O01 — mutable dates | Defensive copies of wallet, transaction, inbox, outbox and event dates; the ledger stores a numeric timestamp and returns a copy. Result snapshots copied and frozen. | `date-immutability.test.ts`: mutating input dates and getter results does not change internal state. |

## Migration and existing history

The migration does not rewrite the four previous ones. It preflights existing values and chains and aborts atomically if there is any divergence. There is no automatic repair, deletion of entries, or disabling of triggers. `down` removes only the new rules.

The tests apply and revert the migration on already populated databases and compare the rows before/after. A disposable database reproduces the corruption using the old schema; the upgrade is refused, the history remains intact, and the migration is not recorded as executed. DDL and history validation acquire locks: the cost on a large database should be assessed when planning the upgrade.

Metrics are operational observations, without durable delivery: a crash between COMMIT and the callback can still cause an operation to go uncounted. The ledger and the outbox events remain the persistent records.

## Dependency patches

The [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) and [sprintf-js](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) advisories listed no fixed release as of the validation date. We kept the versions and left the alerts visible, with versioned patches in `patches/` declared in `patchedDependencies` in package.json/lockfile:

- `braces@3.0.3`: limits nesting in the parser and in the recursive walkers. Deep patterns below the character limit and ASTs passed in directly are refused with a controlled syntax error. Common patterns and ranges keep working.
- `sprintf-js@1.0.3`: limits the precision of `e`/`f` to 0–100 and of `g` to 1–100, avoiding the RangeError from the reproduced precision specifiers. Common formats keep their output. This dependency lives in the migration tooling, outside the APIs/workers image.

The Dockerfile copies the patches before `bun install --frozen-lockfile`, including in the production stage. The tests load the installed packages, not simulated copies. **`bun audit` still reports two warnings and exits 1**, since it checks upstream versions. No advisory suppression was used. Reassess and remove the patches once a compatible upstream update is available; they do not represent a full audit of these libraries.

## Shutdown past the deadline

The additional probe confirmed that the old consumer returned from `stop()` while keeping two messages invisible after the deadline. It now tracks the entire received batch, stops heartbeats, waits for extensions already sent, and releases unacknowledged messages with zero visibility. Work that finishes after losing ownership does not ACK or change visibility using the old receipt. A second loop cannot start on the same instance while the first is still finishing.

`consumer-shutdown.test.ts` uses real PostgreSQL and SQS and pauses the SQL before the commit. With the deadline set to 100 ms, it verifies release of the active message and of the next message in the group; waits for a heartbeat period to pass; starts another consumer; releases the old commit; and confirms deduplicated redelivery, no late ACK from the old consumer, and an exact final balance. The test exercises the expiration branch without waiting for the 20-second default. The release is best effort if the broker is unavailable; in that case, the visibility timeout remains the recovery mechanism.

## Isolation and validation

Infrastructure used: project `jungle-fix-20261022-02`, its own networks and PostgreSQL volume, images tagged for that project, and nginx on `127.0.0.1:18082`. Resolved names, volumes and mounts were checked before starting. No container of the original stack was updated or restarted during this fix step.

Besides the suites, the full Compose stack was started with the compiled images and the separate migration job. Healthchecks, three `X-Instance-Id`s through nginx, wallet creation, BET and reconciliation were checked. The runtime image was inspected: no migrator, umzug, sprintf-js or ESLint; braces patch present. The sprintf-js patch was exercised in the migration image.

To check the safety of the E2E suite, a wallet and its records were created in the application database of the disposable stack, and a sentinel message was sent to the fixed events queue. The E2E suite ran with `E2E_DB_NAME=wagering` and an invalid `E2E_BASE_URL` set on purpose. Afterwards, the row counts and hashes of the five application tables were unchanged and the sentinel message was still available. The test uses only its own resources. Nginx routing is checked separately by the Compose smoke test; the seven E2E tests go directly to the compiled APIs.

The final run numbers are in [TEST_REPORT.md](TEST_REPORT.md). The long-running load test was not repeated for this fix; the historical load results remain labeled as such.
