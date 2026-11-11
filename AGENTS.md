# Agent guidelines for Dispand

What Dispand is and for whom: `docs/PRODUCT.md`. How it is built: `docs/ARCHITECTURE.md`.
Work in progress: the GitHub issues. Design documents, plans and task contracts live outside
this repository.

Public repository: nothing identifying anyone goes in. Commits and pull requests carry no
personal e-mail address and no detail of private infrastructure. Workflows run on GitHub-hosted
runners.

## Checks

Tool versions come from `.mise.toml` (`mise install`). Before committing, run:

```sh
pnpm install
pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build
```

CI runs the same steps (`.github/workflows/ci.yml`). Pull requests must also pass the scrub
check (`.github/scrub.sh`, run by `.github/workflows/scrub.yml`; a legitimate match is listed
in `.github/scrub-allow.txt`) and dependency review (`.github/workflows/dependency-review.yml`),
and their description follows the sections of `.github/pull_request_template.md`.

## Standing rules

- Where a maintained, standard-shaped library exists for a surface or subsystem (the official
  MCP TypeScript SDK, the Agent Plugins specification's loading rules, Better Auth, the UI
  component set already in use), use it. A change that builds such a thing by hand says why no
  library fits.
- Once the telemetry module exists, every new module ships its traces, metrics and structured
  logs in the same pull request, and no secret may reach telemetry.

## Review guidelines

What a real problem looks like here (report it with the file, the line, what triggers it and
what happens then):

- An API procedure without the authorization it needs, or a public (OpenAPI) procedure that
  wasn't meant to be public.
- Input not validated by the procedure's Zod schema, or an error leaking internals to clients.
- A database migration that loses data or can't run on the existing data.
- A test weakened so it no longer guards what it did (deleted assertion, skipped test,
  widened expectation).
- A secret in the code, a log, a client bundle or a commit; anything that sends a secret
  (token, key, code, password) to the browser.
- An oRPC procedure that skips `authed` without being one of the few meant to be public.
- Runner code that widens what the server may make it run: the runner's local config
  (`roots`, `allowBypass`) and its denied settings files must stay out of the server's reach.
- A change to the runner protocol without a version bump.
- Publishing any port in `deploy/compose.yaml` but the app's 3000 (which only the reverse proxy
  may reach), or reading a client-IP header other than `X-Real-IP`.
- An attachment served inline without its first bytes being sniffed as a raster image, or a
  file path built from anything but the owner id and the attachment id.
- A procedure, scheduler path, engine step, runner message or tool call added without its
  span, metric or log (`packages/domain/src/telemetry/`), or telemetry that records content
  (a row value, a prompt, a message, a tool's arguments or result, an answer) or an error's
  message: only ids, names, counts, durations and kinds; a metric attribute not listed in
  `telemetry/metrics.ts`.

Don't report:

- Hardening ideas with no concrete way for someone to reach the problem (who, from where,
  what they gain).
- Formatting and lint: the linter decides.
