# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# The supervisor: the runner, with `claude` and `codex` for signing in on this machine. Build
# from the repository root, after the worker image, naming that one by digest:
#   docker build -f apps/runner/Dockerfile --build-arg WORKER_IMAGE=<image>@sha256:<digest> .
# Its state (pairing, CLI logins, run state) is the volume at /var/lib/dispand-runner.

# The docker client the supervisor starts its workers with (the daemon stays the host's).
FROM docker:29-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d AS docker-cli

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
RUN pnpm install --frozen-lockfile --filter "@dispand/runner..." \
 && pnpm --filter @dispand/runner run build

FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
# The worker this supervisor starts, by digest: fixed at build, out of the server's reach.
ARG WORKER_IMAGE
RUN case "${WORKER_IMAGE}" in *@sha256:*) ;; *) echo "WORKER_IMAGE must name the worker image by digest" >&2; exit 1 ;; esac
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The same CLI versions as the worker: one lockfile for both images.
COPY apps/runner/clis/package.json apps/runner/clis/package-lock.json /opt/dispand-clis/
RUN cd /opt/dispand-clis \
 && npm ci --omit=dev --no-audit --no-fund \
 && ln -s /opt/dispand-clis/node_modules/.bin/claude /opt/dispand-clis/node_modules/.bin/codex /usr/local/bin/ \
 && npm cache clean --force
COPY --from=build /repo/apps/runner/dist/dispand-runner/ /opt/dispand-runner/
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN printf '#!/bin/sh\nexec node /opt/dispand-runner/main.mjs "$@"\n' > /usr/local/bin/dispand-runner \
 && chmod 755 /usr/local/bin/dispand-runner \
 && mkdir /var/lib/dispand-runner \
 && chown node:node /var/lib/dispand-runner
# HOME holds the runner's config and state and the CLIs' logins: all on the one volume, whose
# name (or host path, for a bind mount) workers mount their conversation's folders from.
ENV DISPAND_WORKER_IMAGE=${WORKER_IMAGE} HOME=/var/lib/dispand-runner DISABLE_AUTOUPDATER=1 \
    DISPAND_STATE_VOLUME=dispand-runner
USER node
WORKDIR /var/lib/dispand-runner
CMD ["dispand-runner", "run"]
