# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# The worker: one per conversation, started by the supervisor (`apps/runner/Dockerfile`), which
# names it by digest. It holds the CLIs and nothing of the runner: no config, token or login.
# Build from the repository root: `docker build -f apps/runner/worker/Dockerfile .`
FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
# git and ripgrep for the CLIs' own tools.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The same CLI versions as the supervisor: one lockfile for both images.
COPY apps/runner/clis/package.json apps/runner/clis/package-lock.json /opt/dispand-clis/
RUN cd /opt/dispand-clis \
 && npm ci --omit=dev --no-audit --no-fund \
 && ln -s /opt/dispand-clis/node_modules/.bin/claude /opt/dispand-clis/node_modules/.bin/codex /usr/local/bin/ \
 && npm cache clean --force
# The image's CLIs are the pinned ones: no self-update.
ENV DISABLE_AUTOUPDATER=1
USER 1000:1000
WORKDIR /workspace
