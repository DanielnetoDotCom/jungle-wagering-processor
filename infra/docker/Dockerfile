# syntax=docker/dockerfile:1.7
#
# One application image, several entrypoints (api, consumer, outbox-worker,
# reference-worker, queue-bootstrap); separate migration image. Stages:
#   deps      -> all dependencies from the frozen lockfile
#   dev       -> sources + dev dependencies (tests, lint, demo tools)
#   build     -> tsc output (type-checked JavaScript)
#   prod-deps -> production dependencies only
#   runtime   -> slim, non-root, compiled code only
#   migration-runtime -> compiled code + migration tooling, owner access only for the job

ARG BUN_VERSION=1.4.3

FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

FROM deps AS dev
ENV TZ=UTC \
    NODE_ENV=test
COPY --chown=bun:bun . .
RUN chown bun:bun /app
USER bun
CMD ["bun", "run", "test"]

FROM dev AS build
RUN bun run build

FROM oven/bun:${BUN_VERSION} AS prod-deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    TZ=UTC
COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun package.json ./
USER bun
EXPOSE 3000 9100
CMD ["bun", "dist/src/entrypoints/api.js"]

FROM runtime AS migration-runtime
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
CMD ["bun", "dist/src/entrypoints/migrate.js", "up"]
