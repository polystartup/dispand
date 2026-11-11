# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# Build: `docker build .` from the repository root. Runs `apps/web/server.ts` on Node.
# Base images are pinned by digest (Dependabot proposes updates); pnpm is the exact release in
# package.json's `packageManager`, checked against its published SHA-512 before it runs.

FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS build
ARG PNPM_VERSION=12.17.0
ARG PNPM_SHA512=b8d223ebec04b580a89ed206daa71d1bccb6a1ee1d52efa95cc3b0db75271561df8f0d8e2c43add39c5ec08018af7a8a95108e7090f95a29f88727b7a40fd53d
RUN cd /tmp \
 && npm pack --silent "pnpm@${PNPM_VERSION}" \
 && echo "${PNPM_SHA512}  pnpm-${PNPM_VERSION}.tgz" | sha512sum -c - \
 && npm install -g --ignore-scripts "./pnpm-${PNPM_VERSION}.tgz" \
 && rm "pnpm-${PNPM_VERSION}.tgz"
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# Builds the web app and the runner; the runner's tarball and install.sh end up in
# `apps/web/dist/client/runner/`, served as static files.
RUN pnpm run build
# The web app with its production dependencies only, built output included.
RUN pnpm --filter @dispand/web deploy --prod --legacy /out \
 && cp -r apps/web/dist /out/dist

FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
ENV NODE_ENV=production PORT=3000
# git fetches plugin marketplaces and plugins (packages/domain/src/plugins/git.ts).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
# PGlite (`DATABASE_URL=pglite:///data/db`) keeps its files here.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
# The preload hooks the HTTP server, the PostgreSQL driver and fetch for telemetry before they load.
CMD ["node", "--import", "./telemetry-preload.mjs", "server.ts"]
