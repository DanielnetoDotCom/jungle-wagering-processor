# AGENTS.md

## 1. Purpose

This file defines the rules that any coding assistant (Copilot, Claude, Cursor, etc.) must follow in this repository. Architecture decisions belong to the author and live in [ARCHITECTURE.md](ARCHITECTURE.md); the assistant works within those decisions and does not change them without approval.

## 2. Non-negotiable invariants

- Money is never `number`/float: always `Money` (decimal.js, scale 2) in the domain, `NUMERIC(20,2)` in the database and a decimal string in contracts. `check:money` and ESLint block regressions.
- The ledger is append-only: no `UPDATE`/`DELETE`, enforced by a trigger and by grants.
- The balance never goes negative (database CHECK and domain rule).
- No event is published before the commit: Transactional Outbox, written in the same transaction as the financial effect.
- The SQS ack (`DeleteMessage`) only happens after the commit.
- Idempotency is always persisted in the database (unique keys and inbox), never in memory.
- Concurrency is controlled per `walletId` (`SELECT … FOR UPDATE` on the wallet), with no global lock.
- Uniqueness, immutability and non-negativity are enforced by the schema (constraints, unique indexes, triggers), not only by code.

## 3. Architecture boundaries

Hexagonal, with dependencies pointing inward:

| Layer | Folder | May depend on |
|---|---|---|
| Domain | `src/domain` | itself and pure libraries only (decimal.js). No NestJS, no ORM. |
| Application | `src/application` | domain and ports (`application/ports`) |
| Infrastructure | `src/infrastructure` | application and domain; implements the ports (MikroORM, SQS, Prometheus) |
| Interfaces | `src/interfaces` | HTTP (NestJS), SQS consumer, Zod contracts |
| Bootstrap | `src/bootstrap`, `src/entrypoints` | composition and processes |

- Boundaries are checked by `no-restricted-imports` in ESLint.
- Entities and aggregates have private constructors and static factories: `create`/`open`/`receive`/`enqueue` validate; `rehydrate` rebuilds persisted state without revalidating transitions.
- Mapping between domain and database lives in `infrastructure/persistence/mikroorm/mappers.ts`.
- The schema only changes through a new migration in `migrations/`, registered in `migrations/index.ts`.

## 4. Expected assistant workflow

- Make small, focused changes; read the existing code and ARCHITECTURE.md before changing anything.
- Do not add dependencies without explicit justification (versions are pinned in `package.json`).
- Every bug fix starts with a test that reproduces the bug and fails.
- Never weaken, skip or mock an integration or concurrency test to make it pass. These tests use real PostgreSQL and LocalStack.
- Never change a migration that was already applied: create a new, reversible one (`up` and `down`).
- Follow the surrounding style. Everything in the repository is written in English: code, comments and documentation.
- Do not publish anything to a remote (push, PR, images) without the author's authorization.

## 5. Definition of done

- `bun run verify` is green: ESLint with no warnings, Prettier, strict `tsc`, `check:money`, build, and the unit, integration, concurrency and fault suites.
- `bun run test:e2e` is green whenever the cross-process flow is affected.
- The invariant `wallet.balance == balance rebuilt from the ledger` is checked at the end of the suites (`expectAllWalletsConsistent`).
- ARCHITECTURE.md is updated when a decision changes, and README/TEST_REPORT when commands or results change.

## 6. Human review

- The author reviews all generated code before committing.
- Critical areas require line-by-line review and a justification in ARCHITECTURE.md: the financial transaction (`process-wager-transaction`, `settlement-recorder`, `wager-settlement.service`), locks, outbox, inbox/idempotency and migrations.

## 7. Useful commands

Bun is not needed on the host: everything runs through Docker Compose (the `toolbox` image).

```bash
docker compose up -d --build                     # full stack: 3 api, 3 consumer, 2 outbox-worker, 1 reference-worker
docker compose up -d --build --scale api=3 --scale consumer=3 --scale outbox-worker=2
docker compose run --rm migrations               # migrations (up) + runtime login
docker compose --profile tools run --rm toolbox bun run migration:status
docker compose --profile tools run --rm --build toolbox bun run verify     # lint + typecheck + build + tests
docker compose --profile tools run --rm toolbox bun run test:integration   # also: test:unit, test:concurrency, test:fault, test:e2e
```
