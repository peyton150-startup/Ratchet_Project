# One backend image, started three ways. The API, the pipeline worker and the migration runner
# are the same build with different commands:
#
#   API (default)   node packages/api/dist/index.js
#   worker          node packages/api/dist/pipeline/worker.js
#   migrations      node packages/api/dist/migrate.js
#
# The layout under /app mirrors the repository, so these are the same paths used everywhere else
# and migrate.js still finds ../migrations relative to its own file.

FROM node:22-slim AS base
# Pinned to the pnpm that wrote pnpm-lock.yaml (lockfileVersion 9.0). There is no packageManager
# field to read it from, so an unpinned corepack would pick whatever is newest.
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
# Every workspace manifest, including packages that are not built here: pnpm validates the
# lockfile against the whole workspace before it applies --filter.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY packages/workers/package.json packages/workers/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter "@workspace/api..."
COPY tsconfig.json ./
COPY packages/sdk packages/sdk
COPY packages/api packages/api
# sdk first: the API resolves @workspace/sdk through its dist/.
RUN pnpm --filter @workspace/sdk build && pnpm --filter @workspace/api build

FROM base AS runtime
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod --filter "@workspace/api..."
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --from=build /app/packages/api/dist packages/api/dist
COPY packages/api/migrations packages/api/migrations
COPY packages/api/certs packages/api/certs
# Supabase signs its Postgres certificates with its own CA, which is not in Node's trust store.
# Adding it here is what lets `sslmode=require` verify the server instead of failing with
# SELF_SIGNED_CERT_IN_CHAIN. It extends the default store, so Upstash's public CA still works.
ENV NODE_EXTRA_CA_CERTS=/app/packages/api/certs/supabase-root-2021-ca.crt
USER node
EXPOSE 3000
# Exec form, so node is PID 1 and receives SIGTERM directly for graceful shutdown.
CMD ["node", "packages/api/dist/index.js"]
