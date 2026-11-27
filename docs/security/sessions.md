# A session, to the machine it runs on

- **The runner's container image runs each session's CLI in a worker of its own** (the sandbox
  contract, `apps/runner/src/sandbox/worker.ts`). The supervisor keeps the pairing token, the CLI
  logins, the permission broker and the path checks. Its workers are named by digest at build,
  started under gVisor (`runsc`, named on every launch: a missing runtime fails the launch), as
  the supervisor's own non-root user, on a read-only image, with no capability and no new
  privileges. Under gVisor a worker gets no OCI seccomp profile (`seccomp=unconfined`): gVisor's
  own kernel is the boundary, its host-side filters stay, and runsc ignored that profile until
  release 20261123.1, whose default (Docker's) would stop Codex's sandbox (bubblewrap) from making
  its namespaces. Under runc, Docker's default profile stays. Each mounts only its session's run
  folder (at the path the supervisor uses) and that conversation's transcripts
  (`<roots[0]>/cli/<runKey>`: Claude Code's `projects/`, Codex's `sessions/`); each CLI's home is a fresh tmpfs at every launch, so nothing a worker wrote
  loads again as settings, hooks or plugins, and a conversation resumes in a fresh worker from
  its workspace and transcript alone. Every worker and its network carry their supervisor's
  container id: at each start, before taking any session or resume, the supervisor removes what
  a previous run of its own left and waits until the runtime confirms each is gone. A worker
  gets none of the supervisor's environment: only variables the runner set for that launch. A
  session counts as ended once the runtime confirms its worker, and every process in it, is
  gone.
- **A worker's only route is its supervisor** (`apps/runner/src/sandbox/egress.ts`). Each worker
  is alone on an internal Docker network with no host address on it (`inhibit_ipv4`), which the
  supervisor joins and listens on. Through it, a worker reaches the network only by `CONNECT`:
  the supervisor resolves the name, refuses it if any address it resolves to is a metadata or
  other host-only credential endpoint (AWS, GCP, Azure, Alibaba; in any IPv4 or IPv6 form),
  loopback, link-local, one of the host's addresses (read at each check by a
  helper on the host's network, the runner's own code with no capability, since a supervisor in a
  container can't see them; `DISPAND_HOST_ADDRESSES` adds addresses where Docker's network isn't
  the machine's, as under rootless Docker; no answer refuses the check) or inside a network the supervisor is on (its bridge and the
  host's gateway, other containers, every other worker), and connects to an address it
  checked. Other private destinations stay reachable, as from the machine. The runner's model
  keys (`modelKeys`, set on the machine with `dispand-runner model-key`) are never in a worker:
  the supervisor forwards only a configured provider's model operations (Anthropic's
  `/v1/messages` and `count_tokens`, OpenAI's `/v1/responses`) to that provider's own origin,
  replacing the worker's credentials with the key, and never follows a redirect. When the
  worker ends, its listener, every connection through it and its network go. Workers can't load skills yet: such a session is refused in a worker.
  Every process the runner starts is classified in `apps/runner/src/sandbox/launch-sites.test.ts`:
  in the image, a session's CLI, command and model discovery each run in a worker, and a
  plugin's server (code from Dispand, in a session or a poll) runs in a worker of its own, its
  files read-only and its data folder writable; only the docker client, the machine's own
  runner tools and CLIs' start-up checks run in the supervisor.
- **A worker's session reaches its tools only through the CLI's own channel**
  (`apps/runner/src/sandbox/tools.ts`). The supervisor connects to every MCP server the session
  gets (the Job's, tools reached by URL with their headers, runner tools through `mcp-proxy`) and
  offers them to Claude Code as in-process SDK servers, to Codex as dynamic tools. No process in
  the worker holds a tool's address, token or command. Each call is decided by the permission
  broker before the supervisor makes it: Claude Code's hooks, and for Codex the same decision as an
  MCP call's. Each start of the image checks its host: it uses gVisor
  when Docker has `runsc` and a probe runs under it, otherwise runc, where it runs only the
  sessions verified there (`apps/runner/src/sandbox/verified.ts`: Claude Code and restricted Jobs,
  never an ordinary Codex session, which is refused before its worker starts and never retried
  in bypass). Every launch names its runtime, so one that vanished fails instead of downgrading.
  A probe worker then checks the contract's host-dependent guarantees (non-root, no capability,
  read-only image, no runner config or Docker socket, no metadata directly or through its route,
  no host address: a refusal counts as the host answering, and the check fails unless the probe
  first tells both answers apart on this runtime, its route connecting and a closed port of it
  refusing). Until it passes, the image starts nothing the server asks for, and its log
  names the failed checks; native plugin management stays refused in the image. The bare install (`install.sh`) keeps running sessions as the machine's user.
- **A personal subscription is spent only by its subscriber's own attended actions, checked at
  each use, and never enters a worker** (`apps/runner/src/subscriptions/`,
  `packages/domain/src/runners/grants.ts`). It must never happen that a subscription credential
  (login, refresh token, bearer, setup token, account id) reaches a worker, its environment, mounts or retained
  storage; that a model request goes out without a live grant checked at use; that unattended
  work spends a subscription; or that an action switches implicitly to another credential. What
  keeps it so: the person signs the CLI in on the supervisor, over SSH or the console, into a
  store only the supervisor reads (`dispand-runner sign-in`: Codex's own login, or a Claude
  `setup-token` token read from stdin or the environment, never argv); Dispand's web service never relays
  a sign-in link, code or token. Enrollment needs proof from both sides: the person starts it in
  Dispand and confirms its one-time challenge on that runner (`dispand-runner enroll`), binding
  person, workspace, runner and provider identity (for Claude Code, a digest of the sign-in's own
  random id: a setup token can't read its account, so a new sign-in is a new identity); a changed
  identity ends it. Only a Job the
  enrolled person started by hand on that runner is placed on their subscription, chosen once and
  never switched; schedules, triggers, events, polls, consults and workflows use the workspace's
  credential, and an action that can't use its subscription any more pauses (one whose grant ends
  mid-turn fails), never moving to another credential. Each personal action
  gets a short grant and a fresh worker whose only model route is its grant's relay on the
  supervisor (no proxy, none of the runner's keys); a Claude Code worker holds only its grant's
  token as its OAuth bearer and the relay as its base URL. The relay sends only each CLI's model
  operation (Codex's `POST /responses`, Claude Code's `POST /v1/messages`), drops the worker's
  credential headers and attaches the credential only after
  Dispand checks the grant, the actor, the enrollment and the person's workspace access, read
  live, on each request, at renewal and before an answer, a message or a resume is delivered. A
  grant's end, a lost connection or its deadline closes the relay's streams; revocation also
  stops the worker and its whole process tree, and the next grant waits until the runtime
  confirms it gone. An answer, whoever gave it, goes only to the worker that asked while its grant
  holds: one to a request whose worker is gone is never delivered into a replacement, and the action
  stays paused. Dispand receives authorization metadata only, never
  model traffic or credentials. A credential the provider refuses is never retried in a loop:
  Codex's renewal gives up after 3 failures, Claude Code's token (no renewal) after the first 401,
  and either asks for one fresh sign-in. Personal mode runs only in the container runner under
  gVisor: the runner refuses a grant on runc or on the bare install, and enrolls nothing off gVisor. The
  bare install (`install.sh`) keeps today's behavior until it is retired in a later change: its
  machine's own CLI logins serve the workspace's Jobs on that machine, and it gets no personal mode.
- **File tools read and write only inside the session folder (reads also inside the CLI's
  `plugins/cache`, `plugins/marketplaces` and `skills/`, and the session's own skill packages); Bash asks per command.** Reads: Read, Grep, Glob and NotebookRead
  are allowed only when every path they would touch (from their own fields, `~` expanded,
  real paths, a glob's fixed prefix included) is inside the session folder or the CLI user
  config dir's `plugins/cache`, `plugins/marketplaces` or `skills/` (plugins' code, never their
  `data/`, `store/` or lists), or the session's skill packages; anything else is denied, and an input the runner can't
  follow goes to the owner: a path that isn't canonical (surrounding whitespace, a control
  character, `~user`, `.`, `..` or empty segments) for reads and edits alike, braces, or `..`
  past a wildcard. Writes: in the session folder minus
  any `.claude/` and `.mcp.json` in it. Reads and edits go through one resolver
  (`TOOL_SHAPES`: each tool's path fields, `~` expanded, real paths); relative paths are taken
  against the CLI's own current directory as the hook reports it (plain and inside the session
  folder, else asked), and where it isn't known (`canUseTool`) a relative path is asked. LSP, which follows imports
  anywhere, always asks the owner. Every shell command or script (Bash, Monitor,
  PowerShell, Workflow) reaches the owner as a question outside `bypassPermissions`: the hook answers
  "ask" even where the CLI would auto-approve one (`cp` in acceptEdits). A PreToolUse hook (every tool call, every
  permission mode) denies, without asking, any Edit/Write/MultiEdit/NotebookEdit whose target's
  real path is outside the working directory, inside a `.claude/` or a `.mcp.json` at any depth,
  or inside where a symlink in those, or in the CLI's user settings files, hooks and
  `.claude.json`, leads (followed transitively); `canUseTool` and settings rules repeat it
  (`apps/runner/src/boundary.ts`). No root or working directory may be or sit inside a
  `.claude`/`.mcp.json`, nor contain or sit inside the runner's config dir, the CLI's user
  config dir (`$CLAUDE_CONFIG_DIR` or `~/.claude`), `~/.claude.json` or Codex's home
  (`$CODEX_HOME` or `~/.codex`). When Codex is installed, the runner only asks its
  `app-server` for its version and whether it is signed in (`apps/runner/src/codex/`): it never
  starts a login and answers Codex's token-refresh and attestation requests with an error.
  **Codex sessions get the same boundary from Codex's own sandbox** (`apps/runner/src/codex/`),
  line by line: reads, `:workspace`'s read-everywhere minus every `machineConfigPaths` entry
  (as given, as its real path, and wherever a symlink inside it leads, followed transitively),
  denied outright, so a session reads neither the runner's
  token nor the CLIs' config or credentials (Claude's allowlist is narrower; Codex can't express
  one, and those paths are what its reads must never reach). The sandbox is asked to hide only
  what it can mount over, or it fails the session: an entry inside another one is covered by the
  outer one; a socket or a device holds no config or credential and isn't listed; nor is
  anything inside Codex's own socket folder (`/tmp/codex-daemon-<uid>`, which Codex's home links
  into): Codex hides that folder itself, under an empty read-only one, so nothing can be mounted
  there (checked with a real session: it can't be listed or connected to); the Codex executable, which a running Codex links to from its home, isn't a secret and
  must stay runnable. File changes are still refused against the whole list. The rest of the machine (other
  repositories, `~/.ssh`) stays readable, and Codex's known-safe read-only commands run without
  a question: accepted, the price of Codex's own
  sandbox; writes, only the run folder, minus
  its `.codex`, `.agents`, `AGENTS.md` and `AGENTS.override.md` (read-only, as `.claude/` and
  `.mcp.json` are denied for Claude); skill packages, readable only. The sandbox applies to every
  command the owner hasn't approved. An approved command is approved as Claude's Bash is: Codex
  lets the agent ask for `require_escalated`, its approval request doesn't say so (so the runner
  can't refuse it alone), and Codex then runs it writing anywhere but the denied entries, which
  stay denied to reads and writes alike. The owner sees the command whole and decides; blocking
  escalation in Codex (`granular` with `sandbox_approval = false`) would also stop asking about
  commands at all, and those questions stay. The profile comes from the
  runner (`thread/start` config, which overrides the user's `sandbox_mode`); a thread that
  doesn't report it active is refused before any turn. Shell commands: approval policy
  `untrusted`, so every command Codex doesn't know as read-only asks the owner, shown whole
  (input for a running terminal, `writeStdin`, and a command Codex doesn't name are declined
  without a question);
  "always allow" is Codex's per-session acceptance, never an execpolicy or network amendment
  (those persist). A second approval for one command (Codex's "retry without sandbox?"), any
  command asking for additional permissions and every `request_permissions` are declined without
  a question. File changes (applied by Codex itself) are
  declined without a question when any path, a move's target included, resolves (real path)
  outside the run folder, into its Codex config or instructions at any depth, or into a
  `machineConfigPaths` entry, or when the runner didn't see the change; the rest ask the owner
  one by one. Codex questions with a secret are never asked; MCP elicitations are declined (but
  Codex's approval before an MCP tool call, below); a
  user `config.toml` never gains `projects.*.trust_level` from the runner. `bypassPermissions`
  (Codex's `:danger-full-access`) needs `allowBypass`, as for Claude. Approval policy stays
  `untrusted`; the runner automatically approves native commands without additional permissions
  and file changes that pass its protected-path checks.
  **Commands the runner starts for a session's tools come only from its own config.** A runner
  tool is a name: the server sends `{ type: "runner", tool }`, and the runner starts the server
  its `config.json` names under `mcpServers` (command, args, env), or refuses the session before
  its folder or CLI exists; `hello` reports the names only, so the server never sees the
  commands or their `env` (keys stay on the machine), and `pair` and `install.sh --update` keep
  them. In a session, the CLI starts the runner's own MCP proxy (`dispand-runner mcp-proxy`,
  `mcp-proxy.ts`) in its place, and the proxy starts it from the home folder, for Claude Code and
  Codex alike, never the run folder, where the agent could write files its command loads
  (`.npmrc`, `package.json`), with the proxy's environment stripped of every `DISPAND_*`
  variable plus its own `env`: the Job's token never reaches it. The proxy relays every message
  as it came, but a `tools/call` result in a Job's session: its files (images, audio, embedded
  resources' blobs) go to Dispand's files endpoint and the result gets the text naming the Job's
  attachments in their place (see the files paragraph in [browser.md](browser.md)). The token reaches the proxy in its
  environment (for Codex, by name through `env_vars` from the app-server's environment, never in
  `thread/start`), as the Job server's bearer reaches the CLI.
  Listing a runner tool's actions (`tool.discover`) starts only such a server,
  with an MCP client's default environment plus its `env`, from the home folder, its stderr
  dropped, one listing per tool at a time, stopped after 30 s; its `env` values are redacted from
  what it lists before anything reads it, and an error carries the runner's own words, never the
  server's output. A poll's call (`tool.call`) runs outside any session and starts such a server
  the same way; the runner calls the action only if that server marks it read-only
  (`readOnlyHint`) or the server's `pollable` in the runner's config names it (an empty list
  forbids polls), whatever the server asks, so a poll is never a way to make the machine act;
  no approval stands between a poll and its call, so two guards stand instead. A call whose
  arguments name a path sessions are kept from (the runner's config, the CLIs' homes and every
  link out of them, `codexDenied`; each string read every way a file reader might: as given,
  percent-decoded and as a file URL, from the home folder, `~` expanded; a `file:` string none of
  these readings turns into a path is refused) is refused before the server starts. And, since a path check can miss a
  spelling, every string value of the runner's and the CLIs' credential files (16 characters or
  more, read at each call) is redacted from every result by value, with the runner's token and
  the server's `env` values, keys inside items included; only each item's own keys and `type`
  are kept. Out of scope: other files on the machine a server installed with access to them can
  read (installing a filesystem server over the home folder, and marking its read action
  pollable or leaving it read-only, is the owner's choice); Claude Code's `settings.json` is
  among the redacted files, Codex's `config.toml` is not (it holds no credential by default). HTTP MCP servers come from the server with their headers, and are never
  written to the runner's state: Claude Code gets them through the SDK's control channel
  (`setMcpServers`), never on the CLI's command line, which other local users can read; Codex
  gets each header as a variable name (`env_http_headers`), the value only in the app-server's
  environment, never in `thread/start`, kept out of shells (`DISPAND_*`) and out of the
  stdio servers Codex starts (checked on Codex 0.167). A server that doesn't connect ends the
  session before its first turn, naming the server only (the CLI's message may quote a URL that
  holds a secret). Codex has no SSE transport: an SSE server in a Codex session is refused.
  Codex merges a session's server key by key into a same-named one of the user's `config.toml`
  (its headers, token variable or `enabled` would mix into ours), so a Codex session whose
  servers (`job`, `job_tools` or a tool's) the user's config already names is refused before its
  thread starts (`mcpNameRefused`, checked through `config/read` on Codex 0.167). Claude Code's
  `setMcpServers` replaces a same-named user server for the session instead. The names
  `dispand`, `job` and `job_tools` are Dispand's alone, in a Job or not: a server Dispand didn't
  attach that takes one (the user's config, a native plugin's) ends the session before its first
  turn, in both CLIs (`reservedTaken`), so it never gets that name's exemptions.
  A pre-approved action (an agent's Run setting, a run's remembered allow, the Job's exemptions)
  holds only for the exact server it was granted on: Codex names a call's server apart, and
  Claude Code's `mcp__<server>__<tool>` is read by its first segment, so a session where another
  loaded server's tool names could read as a different server's (`ambiguousServer`) is stopped
  before its first turn. No server inherits another's grants through its name.
  Managed Job tools follow their per-agent Run / Ask settings in every permission mode,
  including `bypassPermissions`. Unasked actions proceed; other actions ask one call at a time,
  and remembering an approval changes that agent's permission. Other MCP tools ask outside
  bypass mode. On Claude Code the PreToolUse hook answers "ask" even where a settings rule
  would allow a managed Ask action. Codex servers use `default_tools_approval_mode: "prompt"`
  so read-only hints do not skip the broker; its approval elicitation
  (`codex_approval_kind: mcp_tool_call`) becomes a permission question, never Codex's
  "for the session" or "always". On the server, a runner tool
  is created or moved only to a server its runner reported, and an agent gets runner tools only
  on a CLI harness of that same runner, a skill's required tools included.
  Protocol 18 can carry disabled runner actions in the initial refs and `session.permissions`
  updates. Both harnesses refuse them before unasked grants, bypass, or owner approval, and
  recheck after awaiting an answer. Initial denials also go to Codex's `disabled_tools` and
  Claude's `disallowedTools`. Denials use each harness's native action names: raw on Codex,
  normalized on Claude. If two actions share a Claude alias, denying either blocks that alias.
  Live denials accumulate; a removed server is refused in full,
  and no later update restores it or clears a denial in that session. A preparing session
  applies these restrictions before rebuilding native MCP configuration. Re-enabling applies
  on the next session; calls already executing are not cancelled.
  **Out of scope:** plugin hooks and other user-config files linking into a session's working
  directory, and Bash (asked per command): the owner keeps their own configuration out of agent
  work folders. "Always allow" only adds rules
  to the running session (never to a settings file, never removing rules, adding directories
  or switching to bypass or auto), so an approval can't grant future permissions. Text from
  Dispand that contains `@` goes as written, so no `@file` mention is read before the
  permission checks. Text from Dispand
  (prompts, messages) can't run a built-in slash command such as `/config`: one that starts with `/` goes as written (`client_composed`) unless
  it names a skill or plugin/custom command the CLI reports as not built in. Every other
  permission prompt reaches the owner as a question, and the owner approves exactly what it
  shows: a tool input too large to show whole is denied to the agent, never shown cut. The runner holds no API key and never reads the CLIs' credentials; its token sits in
  `config.json`, mode 0600, written once with the config. AskUserQuestion questions or options
  that the cut to the protocol's limits makes identical are denied to the agent, never asked.

Protocol 20 carries an optional `remember: run | always` on permission answers. Runner MCP
action names in grant lists are bounded raw server-local names, including punctuation. The
runner constructs the fully qualified name and compares it literally; these strings never
become shell/file permission patterns. Server and runner share Claude's MCP name normalization.
If distinct raw actions share a Claude alias, startup grants require all those actions to be
allowed and the server offers no scoped answer for an ambiguous alias. Explicit denials still
win. A scoped answer can add only its question's MCP action to the current session's cache;
live permission updates remain intersection-only, and a revocation during an outstanding
question prevents a late positive answer from repopulating that cache.

The shared native CLI rule matcher parses only Dispand's
bounded rule subset; prefix matching rejects shell syntax, and exact commands match the entire
string. A match never overrides runner roots or denied settings files. Parsed rules must not be
passed to a native CLI's wildcard permission parser or written into its settings.

Saved native CLI rules live on the agent and are exposed only through owner-session list and
removal procedures, never through general agent responses or Job tools. Removing an entry is
serialized on the agent row. Removal affects the next session start or resume; running sessions
retain their permission snapshot. Rule content is never telemetry.

Protocol 21 accepts native allow/deny snapshots only on starts with a Job token. The server
and runner drop rules outside the supported CLI-specific subset. Claude denials win. Claude's
PreToolUse and canUseTool brokers enforce the boundary before a saved native grant; Codex
rejects extra sandbox permissions, repeated command requests and denied file paths before
accepting one. Native rules do not enter CLI settings, execpolicy or network amendments.
The current Codex integration can execute known-safe commands without calling the approval broker; native Codex deny
snapshots are therefore refused before execution. A scoped native denial stops its Codex
session. PreToolUse hooks fail open on errors/timeouts and cannot substitute for this refusal.
Permission questions carry only matching rule candidates; they grant no server authority by
themselves. Their metadata is shown whole or rejected, and an explicit scoped answer can
cache only that matching candidate in the current session. The server binds native candidates to the active Job
and its stored agent/CLI; workflow and cloud questions receive no native CLI scopes. Only
the owner can remember a decision, in the answer transaction. Codex exposes remembered Allow
only; Deny is single-call, enforced server-side as well as in the UI. This restriction reflects
the current integration and can be lifted once a reliable enforcement path exists. Run rules
remain isolated to that Job; future-run writes/removal lock the agent row. Starts/resumes merge
run and current agent rules, refusing excess denials instead of silently dropping them.
Pending allows are rechecked before caching; a removed saved grant becomes single-call.
The existing managed-tool approval path remains unchanged.
