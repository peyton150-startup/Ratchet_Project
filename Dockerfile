# Single image for all three app services (api, worker, web). Each compose service runs a different
# command against it. Deps are installed once; the SDK is prebuilt because api and web import it.
# Node 22 (matches the pnpm the repo pins via package.json "packageManager").
FROM node:22-slim
RUN corepack enable

WORKDIR /app

# Copy manifests first so `pnpm install` is cached until a dependency actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
COPY packages/workers/package.json ./packages/workers/
RUN pnpm install --frozen-lockfile

# Copy the source and build the shared SDK (api/web resolve @workspace/sdk from its dist output).
COPY . .
RUN pnpm --filter @workspace/sdk build

EXPOSE 3000 5173
