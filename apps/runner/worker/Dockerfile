# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# The worker: one per conversation, started by the supervisor (`apps/runner/Dockerfile`), which
# names it by digest. It holds Codex and nothing of the runner: no config, token or login.
# Build from the repository root: `docker build -f apps/runner/worker/Dockerfile .`
FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
# git and ripgrep for the CLIs' own tools.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Codex, the same version as the supervisor: one lockfile for both images. Claude Code is the
# supervisor's install, bound read-only at /opt/claude-code (src/sandbox/worker.ts).
COPY apps/runner/clis/package.json apps/runner/clis/package-lock.json /opt/dispand-clis/
RUN cd /opt/dispand-clis \
 && npm ci --omit=dev --no-audit --no-fund \
 && ln -s /opt/dispand-clis/node_modules/.bin/codex /usr/local/bin/ \
 && mkdir /opt/claude-code \
 && ln -s /opt/claude-code/node_modules/.bin/claude /usr/local/bin/claude \
 && npm cache clean --force
# Its third-party notices: Codex.
RUN --mount=type=bind,source=scripts/third-party-notices.ts,target=/tmp/notices.ts \
    --mount=type=bind,source=LICENSE,target=/tmp/LICENSE \
    --mount=type=bind,source=NOTICE,target=/tmp/NOTICE \
    mkdir -p /usr/share/doc/dispand \
 && cp /tmp/LICENSE /tmp/NOTICE /usr/share/doc/dispand/ \
 && node /tmp/notices.ts /usr/share/doc/dispand/THIRD_PARTY_NOTICES.md /opt/dispand-clis/node_modules
# The image's CLIs are the pinned ones: no self-update.
ENV DISABLE_AUTOUPDATER=1
USER 1000:1000
WORKDIR /workspace
