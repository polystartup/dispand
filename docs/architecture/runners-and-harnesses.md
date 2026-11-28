# Packages, the API, runners and harnesses

- **Apps and packages:** pnpm monorepo. `apps/web` (`@dispand/web`): TanStack Start app,
  UI and server. `packages/domain` (`@dispand/domain`): database, entity schemas and
  procedures. `packages/runner-protocol` (`@dispand/runner-protocol`): Zod schemas of the
  messages between the server and runners. `apps/runner` (`@dispand/runner`): the runner
  installed on agent machines (`apps/runner/README.md`). No production module imports,
  directly or through others, the values of a module that imports it: `pnpm run lint` runs
  dependency-cruiser (`.dependency-cruiser.js`); an `import type` doesn't count, and tests and
  their helpers are left out.
- **API:** oRPC 1.x procedures in `packages/domain/src/rpc`, mounted at `/api/rpc` by a
  TanStack Start server route. The UI only goes through them, so a REST/OpenAPI and MCP surface
  can later export the same contract. Every procedure admits its caller through a gate in
  `rpc/context.ts`: `signedIn` (a person or a Job), `member` or `manager` (a role in the workspace,
  read at each call) or `orgOwner`, and starts from the base named after it (`signedInProcedure`,
  `memberProcedure`, `managerProcedure`, `orgOwnerProcedure`), unless public on purpose (`auth.status`, `auth.setup`, and an
  invitation's sign-up and its preview, checked by its token); a test walks the router for it. A person's own act (their workspaces,
  invitations, profile and subscriptions, what they send a chat, the say over plugins and native CLI
  rules) also passes `notJob`, which refuses a Job with one answer (`auth.personOnly`); a test walks
  the router and the sources so that no procedure refuses a Job inline. A server whose people are created by another flow
  builds the app with `{ setup: false }`: `auth.setup` is then refused and `auth.status` says
  setup isn't needed, so the web app never shows the setup screen.
- **Runners:** `runners.create` (owner) makes a runner and a single-use pairing code (8
  characters, 15 minutes); the runner trades it at `POST /runner/pair` (public) for a token
  (32 random bytes, stored as SHA-256). It then dials `/runner/ws` with
  `Authorization: Bearer <token>` and `Dispand-Protocol: <version>` (`PROTOCOL_VERSION`, bumped by
  every change an older runner can't parse or honor; a test fails on most changes to the messages'
  schemas until `PROTOCOL_DIGEST`, beside it, is set again). An older runner is refused with 426 "update
  the runner" and its version recorded (`runners.protocol_version`; runners seen before protocol 2
  were set to 1 by migration 0009), so `runners.list` reports it `outdated` with the command that
  updates it in place (`install.sh --update`); any other version gets 400. `RunnerHub`
  (`packages/domain/src/runners/hub.ts`, one per app) hands each event to
  its handler (the engine), raises `runners.last_seq`, then acks it; seqs at or below it are
  acked and dropped. Events aren't stored by the hub: the engine keeps transcripts itself.
  Delivery is at least once (a crash between the handler and `last_seq` replays the event); a
  message the protocol refuses (it bounds every string and refuses U+0000, which Postgres can't
  store) is dropped without an ack, and an event the handler can't store (a Postgres data
  exception) is logged, recorded as handled and acked. Nothing is queued for a runner: `send`
  writes only to a ready runner and resolves whether it was written. A connection is ready
  once caught up: the runner's `hello` carries `lastSeq` (the last event it resends), and when
  the hub has handled events up to it, it calls the caught-up handler (`Engine.reconcile`),
  which resends what didn't arrive; if that fails the connection is dropped and the next
  `hello` retries. Revoking a runner (Settings › Harnesses › Runners) clears its token and
  closes its socket; it is refused while a harness uses the runner. A workspace manager can call
  `runners.refreshClis` to send a live runner a `clis.request`. Its matching `clis.replied`
  replaces the stored CLI inventory, including when the report is empty. An unasked one is
  ignored, except that one carrying `subscriptions` (the runner sends it as soon as a personal
  subscription stops serving, with every enrolled one in it) updates those as `hello` does, and
  never the inventory; a server from before this drops it, and the next report says the same.
  Personal CLI subscriptions (protocol 37, `runner-protocol/src/subscriptions.ts`): the runner
  reports each subscription signed in on its supervisor as a digest of the provider identity,
  never a token; a personal action's `session.start` carries a `grant` with a short relative
  deadline; the runner asks `subscription.enroll` and `grant.check` (by `askId`, not
  `requestId`), and the server ends a grant with `grant.end`. Enrollment
  (`runners/subscriptions.ts`): a member calls `runners.startEnrollment` for a runner and gets a
  single-use challenge (32 random bytes, stored as SHA-256, 10 minutes) bound to them, the
  workspace and that runner; typed on the runner, its `subscription.enroll` binds them, the runner,
  the harness and the reported identity digest (`subscription_enrollments`, one per harness per
  runner; a new one replaces the old). The binding is deleted when the runner reports another
  identity or none for that harness (`hello`, `clis.replied`), when the runner is revoked, when the
  person loses their assignment (`removeAssignments`) or ends it (`runners.endSubscription`, only
  their own); `liveEnrollments` also checks the person's access and the runner at each read.
  `runners.subscriptions` shows a workspace's enrollments (runner, harness, whether it is the
  caller's), never the digest, and the stored CLI inventory drops `subscriptions`. Placement
  (`runners/grants.ts`): when a step is authorized (started or queued) it is placed once, in
  `step_runs.placement`: the run's person's own attended Job (started by hand) on a runner where
  they hold a live enrollment for that CLI runs on their subscription, with its actor and
  enrollment kept; everything else (schedules, triggers, events, polls, consults, workflow runs,
  no person) on the workspace's credential, and a CLI whose login is an enrolled subscription
  serves no workspace-credential step without a workspace model key (`engine.fail.personalOnly`).
  Each start or resume of a personal step gets a new grant (`personal_grants`, 5 minutes) after
  checking again the run's person, the enrollment (same id, runner and harness) and their access,
  ending the step's earlier one; so does each message or answer before delivery. A failed check
  pauses the step (held, no slot, `job.paused`), never another credential. Another person's
  answer (a manager's, from their Inbox) is recorded as theirs and waits, worker kept, for the
  subscriber's consent (`questions.consent`, `questions.consent` column: awaiting, then given once,
  bound to that answer and enrollment, `question.consented`). It then goes only to the worker that
  asked (the grant stored with the question, still live), with the answerer still allowed to
  answer; otherwise, as for an agent's answer or a resume that would carry it, the step pauses for
  explicit recovery: neither CLI restores a pending request in a replacement worker. `grant.check` repeats the checks and renews the deadline; an
  expired, ended or failing grant is denied and deleted. Grants end, with `grant.end` to their
  runner, at turn end, when the step ends or pauses, when a newer one replaces them, and when
  their enrollment ends. Personal execution stays off behind `personalSwitch`: nothing is placed
  personally, the hub denies every grant check (`dispand.runner.personal_refusals`), and the
  runner refuses a start that carries a grant.
  `hub.request` sends
  a `tool.discover` and waits for the `tool.discovered` with its `requestId` from that same runner
  (not numbered, not acked; "runner offline" or "timed out" after 45 s otherwise); `hub.call`
  does the same with a `tool.call` (a poll's call of one action, protocol 9) and its
  `tool.called` (the result's MCP content, `isError` and `hasMore`, protocol 10: the server's
  `_meta.result_has_more`, or why the runner refused), a reply of
  the other kind resolving nothing; `runner.tool_call` spans and `dispand.runner.tool_calls`
  and its duration count them by outcome (`ok`, `error`, `refused`, `failed`).
  `SessionStart` is a union on `harness` (`claude-code`, `codex`, whose permission modes are only
  `default` and `bypassPermissions`) and carries `skills` and `mcpServers` by reference; the engine
  sends none yet. The runner refuses a start with MCP servers, or for Codex, before making its
  folder. Skills: before the run folder, it fetches each package from `GET /runner/packages/<id>`
  (Bearer runner token; `packageForRunner` in `skills/runner-access.ts` gives only a package an
  agent on that runner uses, which needs the agent skills, so none yet). It then writes each one
  read-only as a plugin under `runnerStateDir()/sessions/<hash of the session id>/plugins/<name>`
  (`apps/runner/src/skills.ts`: the runner's own `.claude-plugin/plugin.json`, then
  `skills/<path>`, each `SKILL.md` rewritten by `canonicalSkillMd` with only `name` and
  `description` (one line, no `---`) in its frontmatter and every `@` turned into `＠`). Those are loaded as the SDK's `plugins` (`skipMcpDiscovery`), readable by the
  session's file tools and never editable. They are written again at each start or resume and
  removed when the session ends (and on the runner's start). A plugin error at init that names one
  of them ends the session; a duplicate name doesn't.
- **Native skill selection (protocol 16):** the runner bundles checksum-pinned Skillshare
  executables for Linux x86-64 and ARM64. Runner updates carry the tested dependency version
  (`build.json` records it), with no runtime dependency downloads or system PATH lookup. The local
  installer’s `--native-plugins` option sets `pluginTargets: "managed"`; ordinary updates preserve
  this choice, with absence or `{}` keeping native management disabled. Managed accounts follow
  the session CLI homes in a runner-private Skillshare config; explicit target maps retain
  operator-configured accounts. The owner-only
  `runners.workspacePlugin` resolves a workspace plugin or
  standalone skill package and one or two CLI harness ids on the same runner, previews through
  Skillshare, then applies only the reviewed revision. Uninstall selects one harness. Complete plugins use their stored repository/commit/entry; standalone
  packages use a persistent content-addressed skills-only plugin written by the session writer.
  `runners.workspaceSkills` groups plugin skills together in the Harness inventory. Neither
  procedure is exposed to agents. The install sheet’s initial Install click approves its selected
  native targets, imports workspace components once, then automatically previews and applies a
  combined operation per runner. Status is shown beside each harness; failures never repeat the
  workspace import or successful native installations. At session start
  and resume, `packageForRunner` supplies the stable native name and source key, and fresh native
  inventory decides whether to omit the stripped copy. Only an installed, known-enabled matching
  binding on the chosen harness, without pending or changed context, qualifies. Other states keep
  the workspace copy. Complete plugin actions affect its hooks, commands and MCP integrations too;
  the UI warns before apply. Native execution failures never retry with workspace skills.
- **Harnesses:** a harness is `cli` (Claude Code on a runner, with a permission mode) or `cloud`
  (`anthropic`, `openai` or `openai-compatible`: base URL, model, system prompt, max tokens,
  effort, temperature for `openai-compatible` only), in `harnesses` with `type`
  (`packages/domain/src/harnesses`). A cloud harness's API key is sealed in `api_key_sealed`
  (AAD `apiKeyAad(id)`); views carry only `apiKeySet`, an omitted key on update keeps it (unless
  the provider or base URL changes: the key is then dropped, so it never reaches another URL) and
  `""` clears it (only `openai-compatible` may have none). Harnesses, marketplaces, plugins, skill
  packages and tools belong to a workspace (`workspace_id`); their names are unique per workspace. A key goes only to an `https://`
  base URL, or plain http to loopback; an address with a user name or password is refused. `loadCloudHarness` (server-only) opens it for the model
  clients (`cloud/model-client.ts`). `harnesses.models` lists a provider's models
  (`cloud/models.ts`: no redirects, 10 s, errors are "The provider refused the key" or
  "Couldn't reach <host>", never the provider's body).
- **Cloud sessions:** a step whose agent uses a cloud harness runs in process, in `CloudRunner`
  (`packages/domain/src/cloud/runner.ts`), which Dispand's engine drives like a runner:
  `RoutingAdapter` hands cloud sessions to it and CLI ones to the hub, and it reports the same
  `HarnessEvent`s, with `runnerId` `cloud` (`CLOUD_SOURCE`). Dispand runs the tool loop: the
  model gets the built-in `ask_user` (Claude Code's `AskUserQuestion` shape, a `choice`
  question) and, in a chat or a step that expects outputs, `submit_outputs` (`builtins.ts`, the
  runner's rules and texts: `confirm-outputs` in a chat only when later steps expect values,
  one reminder elsewhere; any other step,
  such as a consulted Job, ends with its last message as `result`), and the agent's tools through a `ToolCaller` (none until
  agents get tools); every other tool call asks a `permission` question, unless its spec says
  `ask: false` (read at every call). Tool questions carry a server-resolved memory offer.
  `Engine.answer` writes run-only decisions or per-agent permissions in the same transaction
  as the answer. The installed tool caller reads those permissions; it never grants them
  independently. Tool calls of a turn run one after another, and a
  turn makes at most 50 model calls. Each session is a `cloud_sessions` row: its history
  (append-only, the provider's raw assistant content replayed), what it waits on, the tool call
  in flight, its event seq and last event. Every state change is written with the seq of the
  event it causes before that event goes to the engine, one at a time, so on boot
  (`Engine.recover`, then `reconcile("cloud", …)`) only the last event is handed over again, and
  the engine drops it by seq; a tool call cut by the restart is answered "it may or may not have
  run" instead of being run again, and a model call cut by it is made again (its streamed text
  may show twice). A shutdown cuts the turns under way the same way (`Engine.stop` closes the
  runner): no session's loop writes after the database closes. Out of scope for now: an event the engine fails to store is logged and not
  retried (only the last one is replayed on boot), and a provider answer holding U+0000, which
  JSONB can't store, ends the session with an internal error. The harness and its key are loaded at each model call, the agent's model
  overriding the harness's; a provider error ends the step with a short reason
  (`providerError`), never the provider's body. A transient one (408, 409, 429, a 5xx, a
  connection lost or timed out, Anthropic's overload streamed after its 200, unless the
  provider's `x-should-retry` says otherwise) first makes the call again (a message queued
  meanwhile joins it, as at any model call), up to 5 times, after what the provider asks (`retry-after-ms`, `retry-after`, at most 5
  minutes) or else 5 s doubling (`retryDelay`, `cloud/clients.ts`; the SDKs' own retries are
  off, as each bounds its waits its own way). Not once the answer's text began to stream, and in
  this process only: the wait is kept nowhere, so a restart makes the call at once.
