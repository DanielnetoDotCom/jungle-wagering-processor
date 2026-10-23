# CI/CD

The workflows live in [`.github/workflows/`](../.github/workflows/). Third-party Actions are pinned by SHA; Dependabot proposes updates to those pins. Every job uses minimal permissions, installs with a frozen `bun.lock`, and has time limits.

## Checks on every push and pull request

The **CI** workflow runs on pushes to `main`, `v*` tags, pull requests, and manual dispatch:

| Job | Evidence |
|---|---|
| Quality and unit tests | ESLint with layer boundaries, Prettier, strict TypeScript, `check:money`, build and unit tests. Publishes JUnit and LCOV coverage for the files exercised by the unit tests. |
| PostgreSQL and SQS — integration | Reversible migrations, runtime grants, SQL attacks on the schema, atomicity, HTTP, inbox, outbox, retry/DLQ, pending references, and shutdown past the deadline. |
| PostgreSQL and SQS — concurrency | Simultaneous operations, three instances, idempotency, independent wallets, contention, deadlocks, and non-negative balance. |
| PostgreSQL and SQS — fault-injection | Processes killed with SIGKILL before/after commit, before ACK, and after publishing to the broker; recovery and reconciliation. |
| PostgreSQL and SQS — e2e | Compiled entry points in independent processes, with their own database and queues. |
| Docker Compose smoke | Builds the real images and starts the whole stack; nginx serves at least three APIs; two BETs of 80.00 against a balance of 100.00 produce 201/422; a replay keeps the historical balance after a WIN; payload conflict, ledger and reconciliation are checked. |

Each test job gets its own PostgreSQL 17 and LocalStack 4.14 containers. The tests also create dedicated databases and queues per suite. The smoke test uses a dedicated Compose project per run and removes only its own resources at teardown. Failing tests are not turned into successes. JUnit, coverage, the smoke report and diagnostic logs are kept as run artifacts for 14 days.

Unit coverage is not whole-system coverage: integrations and failures are verified in the real suites, without inventing a global percentage. The long-running load test is still triggered separately; the historical report is in [LOAD_TEST.md](LOAD_TEST.md).

## Image delivery

After **all the CI jobs above pass**, pushes to `main` and `v*` tags call the reusable **Publish images** workflow. Pull requests never publish images or receive write permission on the registry.

Two Linux amd64 images are produced:

- `ghcr.io/danielnetodotcom/jungle-wagering-processor`: runtime for the APIs and workers, without migration tooling.
- `ghcr.io/danielnetodotcom/jungle-wagering-processor-migrations`: migrations job with its own dependencies.

Tags include `sha-<full commit>`, `main`/`latest` for the main branch, and a semantic version for tags such as `v1.0.0`. The job output records the `sha256:...` digest, which should be used to identify exactly one artifact. BuildKit publishes an SBOM and provenance alongside the images. The OCI fields link the package to the source repository and commit.

Authentication uses only the job's temporary `GITHUB_TOKEN` with `packages: write`. No PAT, server password or production credential is needed in the repository. GHCR package visibility and permissions are controlled by GitHub; publishing an image does not automatically make its package public. This flow delivers artifacts; it does not configure a production target or run migrations on external servers.

## Security and maintenance

**CodeQL** analyzes JavaScript/TypeScript on pushes, PRs, manual dispatch, and every Monday. The results appear under Security and quality → Code scanning. This static analysis complements the tests; it does not prove the absence of vulnerabilities.

**Dependabot** tracks Bun (`package.json` + `bun.lock`), the Dockerfile and GitHub Actions weekly. MikroORM, NestJS and ESLint are grouped to reduce incompatible updates across related packages. The changes go through CI again and have no auto-merge configured.

`bun audit` still flags two upstream advisories with no fixed release. The local patches, regression tests and limitations are in [AUDIT_FIXES.md](AUDIT_FIXES.md). These warnings were neither hidden nor turned into a claim that the dependencies are vulnerability-free.

## Local reproduction

```bash
# Checks and all test suites:
docker compose up -d postgres localstack
docker compose --profile tools run --rm --build toolbox bun run verify
docker compose --profile tools run --rm toolbox bun run test:e2e

# Compose smoke test: run in a disposable environment, since it creates wallets and transactions.
docker compose -p jungle-ci-local up -d --build --wait
CI_BASE_URL=http://localhost:8080 bun scripts/verification/compose-smoke.ts
docker compose -p jungle-ci-local down --volumes
```

The smoke test requires an explicit `CI_BASE_URL` to prevent an unconfigured run from silently hitting another local service. Adjust `API_PUBLIC_PORT` and the URL if port 8080 is in use. Do not reuse project, volume or network names from existing installations.
