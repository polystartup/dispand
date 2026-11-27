# Security policy

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting (the repository's
Security tab, "Report a vulnerability"). Please don't open a public issue or post about it
before we answer. We acknowledge reports within a few days.

## Scope

This repository: Dispand's web app, API, runner and the reference deployment in `deploy/`.

## Security model

What Dispand must never do, and what keeps it so. The invariants below are the short list;
the whole model is in [`docs/security/`](docs/security/README.md), one file per trust boundary.
Keep both true: a change to the security model updates `SECURITY.md` or `docs/security/`.

**Who it defends against**, and how far each reaches today, is in
[`docs/security/attackers.md`](docs/security/attackers.md):

- anyone who can reach the app without signing in, and a signed-in person outside the workspace or organization;
- a member of a workspace, a manager and the organization's owner, each trying to go past their role;
- the authors of what agents read: mail, tool results, table rows, plugin and skill files, memory;
- the services Dispand calls, and a paired runner trying to reach more than its sessions were given.

**Not defended against:** an operator with access to the host, its database or the server's
environment, and what a runner does with the sessions it is given: their content and the work done
on its machine. Keep the list true as the product grows: a reviewer judges a
finding by whether its attacker is in it.

A change that weakens an invariant here or in `docs/security/` is a vulnerability.

Each invariant names the test that enforces it, or says that none does. A test covers what its
title says, which may be less than the whole paragraph in `docs/security/`. CI runs these tests;
those under `apps/runner/test/sandbox/` run in the Runner sandbox workflow, on real gVisor.

### [The browser and the network](docs/security/browser.md)

- **Every API procedure checks authorization**, through a gate, but the few meant to be public.
  [`scopes.test.ts`](packages/domain/src/rpc/scopes.test.ts): "every procedure admits its caller through a gate, but the few meant to be public".
  No test enforces that only the public ones are exposed through OpenAPI.
- **Every input is validated**, and what PostgreSQL can't store is refused before any query reads it.
  [`storable.test.ts`](packages/domain/src/rpc/storable.test.ts): "an input PostgreSQL can't store is refused before any query reads it, its field named".
  No test checks that every procedure has a Zod schema.
- **A page loads from, and connects to, the app's own origin only.**
  [`page-security.test.ts`](apps/web/src/server/page-security.test.ts): "a page keeps what it loads and where it sends to its own origin".
- **An agent's text is shown formatted, and loads nothing.**
  [`AgentText.test.tsx`](apps/web/src/components/chat/AgentText.test.tsx): "it loads nothing from elsewhere: only the app's own files as images, and no raw HTML".
- **An artifact runs only when its viewer clicks Run, alone in an opaque frame.**
  [`assistant.spec.ts`](apps/web/e2e/assistant.spec.ts) (end to end): "a generated artifact shows as a card, runs only after Run, in a frame that reaches nothing".
- **File downloads never run in the app's origin**: only a sniffed raster image is shown inline.
  [`files.test.ts`](apps/web/src/server/files.test.ts): "an SVG or HTML named .png is served as a download, never inline".
- **First-run setup creates the initial owner** only with the setup code, and only once.
  [`auth.test.ts`](packages/domain/src/auth.test.ts): "a wrong setup code is refused before anything happens: no user, no hash", "setup is refused once an owner exists".
- **The app is reachable only through the reverse proxy.** No test enforces this: it is how the
  install is deployed (`deploy/README.md`). That setup counts its caller by `X-Real-IP` alone is tested in
  [`rpc.test.ts`](apps/web/src/server/rpc.test.ts): "wrong setup codes are counted by X-Real-IP, whatever X-Forwarded-For says".

### [People and workspaces](docs/security/workspaces.md)

- **Workspace access to a job is checked against the current membership.**
  [`job-access.test.ts`](packages/domain/src/workspace/job-access.test.ts): "a signed-in person's job reads follow current workspace access, including an open stream".
- **A run reads its workspace's catalog, never its starter's.**
  [`no-person-lookup.test.ts`](packages/domain/src/engine/no-person-lookup.test.ts): "no code finds a run's rows by the run's person, but the listed sites".
- **An organization's refusal tells an outsider nothing.**
  [`gate.test.ts`](packages/domain/src/workspace/gate.test.ts): "a person who isn't a member of the refused organization still gets NOT_FOUND there".
- **A person's Assistant is theirs alone.**
  [`levels.test.ts`](packages/domain/src/rpc/levels.test.ts): "a member neither sees nor changes another person's Assistant";
  [`levels-consults.test.ts`](packages/domain/src/rpc/levels-consults.test.ts): "no Job consults an Assistant, another person's or its own person's".

### [Agents](docs/security/agents.md)

- **An agent's Job reaches the workspace's data only through declared tools, within what its agent was given.**
  [`tools.test.ts`](packages/domain/src/platform/tools.test.ts): "every procedure of the router is a tool or declared not a tool, never both";
  [`call.test.ts`](packages/domain/src/platform/call.test.ts): "a table outside the Job's tables is refused like a missing one".
- **An agent changes what agents may do only as a person approved it, write by write.**
  [`proposals.test.ts`](packages/domain/src/platform/proposals.test.ts): "every tool marked as a grant is refused without a proposal".
- **A Job's token is the only way into the Job endpoint (`/mcp/job`), and it dies with the Job.**
  [`token.test.ts`](packages/domain/src/platform/token.test.ts): "a token names its Job while the Job goes on, and nothing after".
- **A poll is never a way around action approvals or an agent's tools.**
  [`pollable.test.ts`](packages/domain/src/tools/pollable.test.ts): "an action an agent must ask before using is never polled, whatever the owner allowed".
- **Memory steers the agents that work on data, never one that configures until a person accepts it.**
  [`read.test.ts`](packages/domain/src/memory/read.test.ts): "a Job that configures never gets, in its prompt, an entry an agent without configure wrote, until a person accepts it".

### [Tool servers, model providers and push services](docs/security/services.md)

- **An agent's tool reached by URL is called only after the owner approved that exact call**, or took the action off the asking ones.
  [`tools-mcp.test.ts`](packages/domain/src/platform/tools-mcp.test.ts): "refuses a call nobody approved, a denied one, and one whose arguments changed".
- **A tool's headers never follow it to another origin or transport.** A change of path or query keeps them.
  [`procedures.test.ts`](packages/domain/src/tools/procedures.test.ts): "a tool's headers never follow it to another address: a new origin starts without them".
- **In production the server never calls its own addresses for a tool.**
  [`mcp.test.ts`](packages/domain/src/tools/mcp.test.ts): "the guarded fetch refuses Dispand's own addresses, by literal and by name".
- **An OAuth tool's tokens, client secret and code verifier never leave the server.**
  [`oauth.test.ts`](packages/domain/src/tools/oauth.test.ts): "a redirect to another origin during the token exchange is refused: no code, verifier or secret reaches it",
  "what the server sends back is redacted of the tool's client secret and tokens".
- **A Web Push carries no content**: a sentence naming the agent or workflow and the item's kind, how many
  items it announces, and the newest one's random id.
  [`sender.test.ts`](packages/domain/src/push/sender.test.ts): "a new approval sends one payload of exactly the sentence, the count and the item's id, no question text".

### [Secrets, logs and telemetry](docs/security/secrets-and-telemetry.md)

- **Secrets entered in the app (API keys, tool headers) are sealed at rest** and never returned.
  [`secrets.test.ts`](packages/domain/src/secrets.test.ts): "open with another aad throws SecretError";
  [harness `procedures.test.ts`](packages/domain/src/harnesses/procedures.test.ts): "no procedure returns the key";
  [tool `procedures.test.ts`](packages/domain/src/tools/procedures.test.ts): "header values never in outputs".
- **Telemetry carries no secret and no content.**
  [`redact.test.ts`](packages/domain/src/telemetry/redact.test.ts): "a value equal to a secret the process opened is dropped, whatever its key";
  [`zzz-telemetry.spec.ts`](apps/web/e2e/zzz-telemetry.spec.ts) (end to end): "telemetry exported during the whole suite holds no secret and no content".
- **The server's secrets come from its environment**, never from git, logs or client bundles.
  No test enforces this.

### [The server and a runner](docs/security/runner.md)

- **Runners authenticate with a revocable token**, never a session.
  [`pairing.test.ts`](packages/domain/src/runners/pairing.test.ts): "pairing code works once";
  [`hub.test.ts`](packages/domain/src/runners/hub.test.ts): "revoked runner token is refused at upgrade".
- **The runner does not trust the server blindly**: its own config decides where sessions run and whether they may bypass permissions.
  [`workdir.test.ts`](apps/runner/src/workdir.test.ts): "a per-run dir under a runs symlink out of the root is refused before anything is created";
  [`claude.test.ts`](apps/runner/src/claude.test.ts): "bypass refused when allowBypass is false".
- **Commands the runner starts for a session's tools come only from its own config.**
  [`mcp.test.ts`](apps/runner/src/mcp.test.ts): "an unknown runner tool is refused". For a plugin's server, see Plugins and skills below.

### [Plugins and skills](docs/security/plugins.md)

- **A runner runs a plugin's code only when its own record matches.**
  [`plugin-servers.test.ts`](apps/runner/src/plugin-servers.test.ts): "a plugin reference the record doesn't hold is refused before anything is fetched; files under another name are refused".
  In the container runner, a native plugin runs instead on its agent's grant:
  [`native-plugins.test.ts`](packages/domain/src/agents/native-plugins.test.ts): "a member, a Job, another workspace's or a generated plugin can't be granted; nothing is saved".
- **Skill files never name a path outside their skill.**
  [`package.test.ts`](packages/domain/src/skills/package.test.ts): "refuses unsafe paths";
  [`skills.test.ts`](apps/runner/src/skills.test.ts): "an unsafe path is refused before anything is written".

### [Sessions on the runner's machine](docs/security/sessions.md)

- **File tools read and write only inside the session folder** (reads also in the CLI's plugin code and skills).
  [`boundary.test.ts`](apps/runner/src/boundary.test.ts): "file tools read only inside the session folder, and the CLI's plugin code and skills/", "edits outside the working directory are denied".
  A Codex session reads more widely (see the model).
- **A shell command asks first**, unless something lets it through: bypass permissions (which the runner's own config
  must allow), a saved allow rule, or, on Codex, an earlier "always allow" in the same session or its own list of
  read-only commands.
  [`claude.test.ts`](apps/runner/src/claude.test.ts): "in %s mode, every shell command asks the owner, even one the CLI would auto-approve",
  "saved native rules pass the boundary first and never become SDK wildcard settings";
  [`session.test.ts`](apps/runner/src/codex/session.test.ts): "command approval asks and maps allow-always to acceptForSession; an execpolicy amendment is never sent".
  No test covers which commands Codex knows as read-only: Codex decides.
- **The runner's container image runs each session's CLI in a worker of its own.**
  [`contract.test.ts`](apps/runner/test/sandbox/contract.test.ts): "non-root, read-only image, no capability, no network, only its own storage and its own variables";
  [`launch-sites.test.ts`](apps/runner/src/sandbox/launch-sites.test.ts): "every process the runner starts is classified, and each worker site passes a worker's launch".
- **A worker's only route is its supervisor.**
  [`egress.test.ts`](apps/runner/test/sandbox/egress.test.ts): "reaches no metadata, host, supervisor or other worker address, by any form or name; a public host, and the model forwarder".
- **A personal subscription is spent only by its subscriber's own attended actions, and never enters a worker.**
  [`personal-placement.test.ts`](packages/domain/src/engine/personal-placement.test.ts): "an unattended run, a run with a missing actor and a run whose actor lost access never get a grant";
  [`supervisor.test.ts`](apps/runner/src/subscriptions/supervisor.test.ts): "the subscription logins are never among a worker's mounts".

## Supported versions

Only `main`.
