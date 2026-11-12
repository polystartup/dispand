# Security policy

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting (the repository's
Security tab, "Report a vulnerability"). Please don't open a public issue or post about it
before we answer. We acknowledge reports within a few days.

## Scope

This repository: Dispand's web app, API, runner and the reference deployment in `deploy/`.

## Security model

What Dispand must never do, and what keeps it so. Keep this list true: a pull request that
changes it updates this file.

- **Every API procedure checks authorization**, and only the procedures meant to be public are
  exposed through OpenAPI.
- **An agent's Job reaches the workspace's data only through declared tools, within what its
  agent was given.** A procedure is a tool only when the registry names it under a bundle
  (`data` or `configure`), or declares it a Job's own tool (`inbox`); every other procedure is declared "not a tool", and a test fails on
  one that is in neither list. No tool exposes secrets, runner pairing, user or session
  management, or anything that deletes a table or a field. Every call is authorized in one
  place: the Job must still be going, and the tool's bundle and every table the call touches
  must be in the Job's snapshot and still on the agent, so a right taken back applies at once
  and a right added later never reaches a running Job. A call then runs as the Job's owner; that
  identity is set only by the authorizing function, never from a request. These calls ask the
  owner no question: the bundles are the permission. `configure` changes fields, not the rows
  under them: a Job can't remove a choice of a field, since that clears the rows that use it.
- **A session gets its agent's skills and tools, and no more.** For a Job, what its snapshot
  holds and the agent still has; for a workflow run, the agent's as they are. A tool reached by
  URL is called on the server only, for cloud sessions, with its sealed headers opened for that
  call: a session start never carries a tool's address or headers, only the names of the
  runner's own MCP servers the agent was given (and only those of the harness's runner). Every
  call of such a tool asks the owner first, in a cloud session as on a runner.
- **An agent's tool reached by URL is called on the server, and on a runner only after the
  owner approved that exact call.** A Job's CLI session gets these tools from a second
  endpoint, `/mcp/job/tools` (same Job token, address built by the runner like the Job
  endpoint's, under the reserved name `job_tools`); it sees each action's name, description and
  schema, never the tool's headers or full address (a failed call may name the tool's host). The CLI asks the owner before each call, like
  for any MCP tool, and that question and its answer are recorded on the server. The endpoint
  runs a call only when it finds, in its own records, an approval of that Job for that tool and
  those arguments (key order aside), answered with an allowance and not used yet, and uses it
  up: it never takes the runner's word that the owner said yes, an approval allows one call,
  and "always allow" is no approval of later calls: it is the owner taking that action off
  the agent's asking ones (below), and the answer itself is used up as it is given. The name a tool is asked and called under
  is derived from the tool's id and the action's name alone, so an approval can't move to
  another tool or action; a tool's schema is passed on as data and never compiled. That name
  is words cut short and a mark, so the question the owner answers also carries, from the
  server, the tool's name and the action's name and description in full. A session in `bypassPermissions` mode asks
  nothing, so its calls of these tools are refused.
- **An OAuth tool's tokens, client secret and code verifier never leave the server.** They are
  sealed per tool, keyed by authorization server, and go only where the MCP SDK's flow sends
  them: the access token to the tool's URL, the rest to its authorization server's token
  endpoint. Not to the browser (views say connected, needs authorization or re-authorize, and
  the entered client id), a runner, an agent, a log or telemetry. Every request of the flow
  (metadata, registration, token, refresh) goes through the connector's guarded fetch: the
  address guard, https only (but to this machine), no redirect to another origin, and the
  connection's 16 MiB budget; a token endpoint's refusal, whatever its status, keeps only its
  error code before the SDK reads (and logs) it. An OAuth tool sends no static header and is
  reached only over https (or on this machine), and what it sends back is redacted of its
  tokens and client secrets. An entered client id and secret are bound to the authorization
  server they were first used with: another one the server names later never gets them. A flow
  or refresh still under way when the tool is pointed elsewhere saves nothing and connects
  nothing. Only
  the owner's session finishes a flow it started, with the `state` it sealed, once and within
  10 minutes. A tool whose refresh is refused is marked "re-authorize": its calls fail before
  any request until the owner signs in again; a call never starts a flow. The client metadata
  document (`/oauth/metadata`) is public on purpose: it holds the app's name and callback only.
- **Telemetry carries no secret and no content.** One module knows OpenTelemetry's SDK
  (`packages/domain/src/telemetry/`; a lint rule keeps it so), and everything it exports goes
  through `redact.ts` first, whoever recorded it (our code, or a library's own spans): an
  attribute whose name is a secret's (`authorization`, `cookie`, `token`, `code`, `state`,
  `api_key`, `password`, `secret`) or a header is dropped; a URL keeps no query string,
  fragment or credentials; an exception keeps its kind only, never its message or stack; a
  span's status keeps no message; and any value equal to a secret the process opened (the
  secret box remembers a salted hash of each, never the plaintext) is dropped. Errors are
  recorded with `recordError` (the kind) and logged with `logError` (its whitelist). Spans and
  logs carry ids, names, counts, durations and result kinds, never a procedure's input or
  output; a metric keeps only the attributes `telemetry/metrics.ts` lists for it. Nothing is
  sent unless `OTEL_EXPORTER_OTLP_*` names a collector, and then only there.
  The HTTP server, the PostgreSQL driver and outbound fetch are instrumented by a preload
  (`apps/web/telemetry-preload.mjs`): no header is recorded; pairing (`/runner/pair`), the
  runner socket, OAuth callbacks and health checks make no span; a call out keeps only the
  origin it went to (a tool's address may hold a secret in its path); a statement is recorded
  without its values; a connection string keeps no password.
- **A page loads from, and connects to, the app's own origin only.** Every HTML page is
  served with a Content-Security-Policy that keeps images (plus inline `data:` and `blob:`),
  media and fonts to the app's origin, connections to it too, and allows no frame, object,
  foreign `base` or form target, nor being framed (`server/page-security.ts`). Text an agent
  wrote is shown in many places; whatever a renderer makes of it, the browser can't be made
  to fetch from, or send to, another host. Scripts and styles are not restricted by it. A
  served file keeps its own stricter policy (`default-src 'none'; sandbox`).
- **An agent's text is shown formatted, and loads nothing.** In the chat an agent's words go
  through one component (`components/chat/AgentText.tsx`): an image shows only when its
  address is one of the app's own files (`/files/<id>`, nothing else: no scheme, no host, no
  `..`), and is otherwise replaced by its description; a link is never an anchor but a
  button that shows its destination and opens it in a new window on a click, and only for
  `http(s)` and `mailto`; raw HTML in the text is not rendered. The owner's own words stay
  plain text. The page policy above stands behind it.
- **An agent changes what agents may do only as a person approved it, write by write.** The
  tools that create or change an agent are marked as grants in the one registry of Dispand's
  tools, and `callPlatformTool`, the single way a Job calls them, runs a grant only when it
  finds and uses up an item of a proposal of that same Job that the owner approved: the same
  tool, the same input (key order aside), not used yet. A proposal is made by the agent
  (`propose`: at most 20 writes and 64 KiB, each validated by its tool and kept as parsed), and
  belongs to its Job: no other Job uses it, and it ends with the Job. The Job's rights are
  checked first and as they are at the call, so an approval never brings back a bundle taken
  since, and the procedure's own checks still apply (what isn't the owner's stays refused). A
  person may approve more than the proposing agent holds: that is what a grant is, and why
  the owner is shown every item whole. The agents an agent may consult, and its description
  (which agents that may consult it read), change the same way: a person on the agent's page,
  or an approved `agents_create` or `agents_update` item. An entry pairs only two agents that
  both have `configure` or neither has, and never an agent with itself.
- **Long work waits for a person; it is never cut.** The Jobs from one root cause pause at the
  workspace's checkpoint, and only a person's answer to its Approval lets them go on: no tool
  answers a question, and every path that makes a session work again reads the root's state
  first (`rootGoing`). A declined root makes no Job and none of its sessions works again, after a
  reconnect or a restart included. Changing the checkpoint is a grant: an agent does it only
  through a proposal a person approved.
- **What can't be undone, what removes a question and what starts Jobs are grants too.**
  Deleting a table or a field, changing an action's asking flag, and creating, changing or
  deleting a trigger (what starts an agent's Jobs, and what the agent is told then) are in the registry with the same mark as
  creating or changing an agent, so the same gate refuses them without an approved item. An
  item is also checked against the Job's tables when it is proposed, like any call: a Job
  limited to some tables can't put another table's deletion in front of the owner.
- **A Question reaches another agent only within what it may read.** Asking, answering and
  expiring a Question or an Approval is an event of ids and kinds, never its text, options or
  answer. An agent's trigger on them starts a Job only for a Question it may read
  (`questions/inbox-scope.ts`, `reachable`): it has `inbox`, the item is a Question (an Approval
  is a person's), asked by a Job of another agent, without `configure`, on tables within its
  own; any other is recorded with no Job and never named to it. Each start of such a Job's
  session checks it again with the Job's rights as they are then (its snapshot's that its agent
  still has), so a revoked table or `inbox` is never sent. The `inbox` tools (`questions_list`,
  `questions_get`, `questions_answer`, in `questions/inbox.ts`) run every call through the same
  `reachable`, with the calling Job's rights as they are then, and then reach only an item
  still open: anything else gets "Not found", and an answered or expired item says only that
  it no longer waits, never its text or answer. Only a Question with choices is reachable: an
  Approval, or a confirmation of a Job's values, is a person's. An agent's answer goes through
  the same one-time pending-to-answered update as a person's, records the agent and its Job,
  and the asking session is told which agent answered in the answer itself, so it never resumes
  on an agent's words taken for the owner's. `inbox` is granted like any bundle: by
  a person, or by an approved proposal.
- **A poll is never a way around action approvals or an agent's tools.** The scheduler calls a
  tool outside any Job only for a poll trigger whose action the tool lets polls read and no agent
  must ask before using, of a tool its agent has (`pollProblem`): checked when the trigger is
  made or changed, before every call (a poll that fails it calls nothing and says why), before
  every Job of an item, and before every start of such a Job's session, which never gets its
  item once the agent lost the tool. Its call takes the tool's own path (the connector's address
  guard and redaction, or the runner's own checks), and what it reads (items, arguments,
  results) never reaches telemetry.
- **No agent makes, unmakes or strips the Assistant.** The workspace's Assistant is the agent
  marked `built_in = 'assistant'`, one per owner (a unique index). That mark is in no
  procedure's input: only `agents.ensureAssistant`, the owner's and not a tool, makes it. One
  check (`assistantGuard`, `agents/builtin.ts`) refuses deleting it, taking `data` or
  `configure` from it, limiting it to some tables, and deleting, turning off or changing the
  kind of its chat, in the owner's procedures and in a proposal's items alike. It holds no
  more than any agent given those bundles: its writes that grant go through proposals.
- **The server calls no address an agent chose before a person approved it, and an agent
  never handles a tool's credentials.** An agent adds a tool only as a proposal item
  (`tools.add`: a name, a URL and a transport, nothing else; a URL with credentials or any
  header is refused when proposed). Making the proposal fetches nothing: the address is first
  contacted, to list its actions, when the approved call runs. The owner reads the address
  whole with the host set apart, and enters the server's headers afterwards on the tool's
  page. Agents can read tools (names, addresses, actions, header names, never values) and
  delete an unused one through a proposal; changing a tool's address, transport or headers
  is not one of their tools at all.
- **A proposal is approved by a person, on what the server shows, never on the agent's words.**
  The agent asks with `request_approval`, naming the proposal's id. The server attaches a
  draft of that same run to the question with one conditional update (so a proposal has one
  question and one answer), and the owner's answer to that question, given through
  `questions.answer` as a signed-in person, approves it; a denial declines it for good. The
  Inbox reads the items from the server's row and shows each whole, with a name for every id
  an item points at (the agent, the harness, tools, skills, tables, a field with its table)
  as resolved for that owner; an id that names nothing of theirs is flagged. Which values of
  an input are ids is the server's own table per tool: any other value is shown as data. A question for a proposal is not
  answerable where its items aren't shown (the chat sends the owner to the Inbox). A request
  naming a proposal that isn't attached (another run's, one already asked, none) is words only,
  and says so. A `proposal` argument that isn't an id is refused as a bad call by the runner
  and by cloud sessions, so it never becomes a request in words in its place.
- **Which actions of a tool run without asking is the owner's choice, per agent, and only a
  person changes it.** Each agent keeps, for each tool it chose, the actions that run unasked
  (`agent_tools.unasked`); every other action asks as above, in a cloud session and at the
  tools endpoint, which read the list at each call (an action put back asks from its next
  call on, in Jobs already running). The list starts with the actions the tool's server calls
  read-only (`readOnlyHint`) when a person adds the tool to the agent. That hint is the
  server's claim and is read only then: a server that later calls another action read-only
  gains nothing, an action that appears later asks, and a tool that only comes with a skill
  asks for everything. A tool pointed at another address or transport asks for everything
  again on every agent: the list named the old server's actions. Only tools reached by URL
  have this list; a runner's own tools ask as its CLI does. The list changes in three ways, each a person's: the owner on the
  agent's page; an item of a proposal the owner approved (the write is a grant: an agent
  can list it, never make it on its own); and the answer "always allow" to an approval of
  that action, in a cloud session or a Job's CLI session. For a CLI session the server resolves
  the name the question was asked under (which stands for one tool and action for good) on
  the run's own agent; a name that stands for nothing the agent chose grants nothing, and the
  runner is then told "allow", once. On "always", the runner only stops asking about that
  name of the Job's tools server in the session that asked. So no agent removes its own questions. Accepted: an unasked action that reaches outside (a search,
  a fetch) can carry in its arguments what the Job read; the owner keeps such actions asking
  on agents that read confidential tables. An unasked action also runs for a session in
  `bypassPermissions` mode.
- **The runner is told which of the Job's tools run unasked, and that only spares prompts.**
  A Job's session start may carry `unasked`: names of the tools endpoint's tools (at most 500,
  each at most 48 characters of `a-z0-9_-` with no `__`). The runner makes the CLI's tool names
  itself, `mcp__job_tools__<name>`, and lets those run without a question, on a session that
  has a Job token only. So the message can't name a command, a file tool, a runner's own MCP
  server or any other server's tool: those questions stay out of the server's reach. Whether
  a call runs is still the endpoint's decision alone, from the agent's list at that moment: a
  name the runner was told but the owner put back since is refused there for lack of an
  approval, and asks again from the session's next start.
- **A Job's token is the only way into the Job endpoint (`/mcp/job`), and it dies with the
  Job.** It is 32 random bytes, made when the Job is created. The database keeps its SHA-256 (to
  find the Job) and its sealed form (to hand it to the Job's CLI sessions at each start), never
  the token; it is not kept with the step, not in a run's view, and never sent to the browser.
  The endpoint answers 401 without a valid token of a Job still going, and every tool call is
  then authorized as above, so the token gives nothing the Job's bundles don't. A session start
  carries the token and nothing else about the endpoint: **the runner builds the endpoint's
  address itself**, as `/mcp/job` of its own configured server, under a reserved name, so the
  server can't make a runner send the token, or run tools unasked, anywhere else. Only that
  server's tools run without a question on a runner; every other MCP tool still asks. A CLI
  names a tool `mcp__<server>__<tool>`, so the protocol only accepts session server names made of
  words joined by single underscores: no other name can give tools that read as the Job server's.
- **Only the owner has a session.** Sign-up is disabled; `auth.setup` (public) creates the
  owner only while no user exists, and only with the one-time code from the server's settings
  (`DISPAND_SETUP_CODE`), so the first-run window can't be claimed from the network.
- **The app is reachable only through the reverse proxy**, which terminates TLS and sets
  `X-Real-IP` to the peer it saw, overwriting what the client sent. That header alone is the
  sign-in rate-limit identity, so nothing but the proxy may reach the app's published port 3000
  (`deploy/README.md`): anything else reaching it could choose its identity.
- **Runners authenticate with a revocable token**, never a session. The token (32 random
  bytes) is shown once to the runner and stored as SHA-256; a pairing code is single-use,
  expires after 15 minutes and is stored as SHA-256 too. `POST /runner/pair` is public and
  answers the same 401 for unknown, used and expired codes, and reads at most 1 KiB of body
  (413 past it); every request body is capped at 1 MiB by the production server (11 MiB for
  `files.upload`, `skills.create` and `skills.update` only; a body without a length is refused). Revoking a runner clears its token
  and closes its connection, and an upgrade still in flight is refused. A runner's
  frames are capped at 1 MiB, and its connection is closed past 1000 messages or 8 MiB waiting
  to be handled; every protocol string, list and record has a maximum. A paired runner is the
  owner's own machine: these limits contain its mistakes, not a hostile runner, which the owner
  revokes. A runner older than the server's protocol is refused (426) only once its token is
  known, and a `tool.discovered` reply only answers a request sent to the runner that replies. A runner's events only reach the sessions the engine started on that runner; events
  for any other session are ignored. The pairing code travels in the environment
  (`DISPAND_PAIRING_CODE`), never in a command line other local users could read. Tokens
  and codes are never logged, and logs carry no error text, only its kind and
  Postgres code.
- **The runner does not trust the server blindly.** Its config on the machine, which the
  server can't change, decides where sessions may run: only in fresh per-run folders the runner creates,
  `<roots[0]>/runs/<runKey>` (refused if it exists; no symlink on the path from the root:
  `runs` is a real directory and the folder's real path is exactly `<root>/runs/<runKey>`; only resuming reuses a folder, and only for a CLI session id the runner itself recorded for
  that run key, in its state dir, mode 0600), and whether `bypassPermissions` is allowed at all
  (`allowBypass`, off by default; when off, sessions also get
  `disableBypassPermissionsMode`). Sessions load the user's own Claude Code settings only,
  never a run folder's `.claude/` settings, hooks, `.mcp.json` or `CLAUDE.md`, on start or
  resume. The server URL must be `https://` (plain http only to
  loopback), in the config, `pair` and `install.sh` (`--update` takes it from `config.json`,
  which it never changes, and checks it the same way).
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
  outer one; a socket or a device holds no config or credential and isn't listed (Codex hides
  its own daemon folder itself, checked with a real session: it can't be listed or connected
  to); the Codex executable, which a running Codex links to from its home, isn't a secret and
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
  (Codex's `:danger-full-access`, approval policy `never`) needs `allowBypass`, as for Claude.
  **Commands the runner starts for a session's tools come only from its own config.** A runner
  tool is a name: the server sends `{ type: "runner", tool }`, and the runner starts the server
  its `config.json` names under `mcpServers` (command, args, env), or refuses the session before
  its folder or CLI exists; `hello` reports the names only, so the server never sees the
  commands or their `env` (keys stay on the machine), and `pair` and `install.sh --update` keep
  them. Each starts from the home folder (`sh` changes to it, for Claude Code and Codex alike),
  never the run folder, where the agent could write files its command loads (`.npmrc`,
  `package.json`). Listing a runner tool's actions (`tool.discover`) starts only such a server,
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
  Outside `bypassPermissions`, every MCP tool call asks the owner, one call at a time: on Claude
  Code the PreToolUse hook answers "ask" even where a settings rule would allow it, and the
  question offers no "always allow"; on Codex, its approval elicitation (`codex_approval_kind: mcp_tool_call`) as a permission
  question each time, never Codex's "for the session" or "always". On the server, a runner tool
  is created or moved only to a server its runner reported, and an agent gets runner tools only
  on a CLI harness of that same runner, a skill's required tools included.
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
- **Files uploaded to tables, or returned by a Job's tools, are the owner's only, and never run
  in the app's origin.** Each is stored at `<filesDir>/<ownerId>/<attachmentId>`, both ids made
  by the server: nothing from the upload or the tool's result (name, type, URI) reaches the path. They are reachable only through the app, at
  `GET /files/<id>`, which needs the owner's session and answers 404 for anyone else's id. A file
  is an image only if its first bytes are PNG, JPEG, GIF or WebP; only those are served inline,
  with that type. Everything else, SVG and HTML included whatever their name or declared type,
  is a download (`application/octet-stream`). Every file gets `X-Content-Type-Options: nosniff`
  and `Content-Security-Policy: default-src 'none'; sandbox`. A cell only holds files of its own
  table. Files are at most 10 MiB. Agents never get a file's content: no tool,
  prompt or runner message carries it. A Job with the `data` bundle sees a row's file names and
  ids, and can set a files cell to files already uploaded to that table (or empty it, after
  which the unused files are swept), like any other value of the row. Files in the result of a
  Job's HTTP tool call (images, embedded resources' blobs; at most 20 a result, each with the
  same bounds and sniffing as an upload) are stored as that Job's, and the agent gets their ids
  in place of the bytes. A Job can write in a cell only its own such files that no table has
  yet, which then become that table's for good (`writeRow` takes the writer from the call, never
  from its input): never another Job's, nor one a person writes. The bytes are stored as the
  server sent them, not redacted like the result's text: only the owner can read them.
- **Skill files never name a path outside their skill.** Every file of a skill package, made in
  the app or imported from a plugin, passes `isSafeRelativePath` (`packages/runner-protocol/src/paths.ts`)
  before it is stored: relative POSIX paths only, no `..`, `.` or empty segment, no `\`, NUL or
  other control character, and no `.claude` or `.mcp.json` segment (in any case), which the
  runner's boundary treats as the CLI's config. The runner checks every path with the same
  function again before it writes anything.
- **Skill files reach a session readable, never editable, and outside every work folder.** A
  runner gets a package from `GET /runner/packages/<id>` with its own token, and only one an agent
  on that runner uses (an agent whose harness is on that runner has it; 404 otherwise). It fetches before
  making the run folder, over the server URL its config allows, with no redirects and a capped
  body. It writes only `<plugin>/.claude-plugin/plugin.json` (its own `{ "name" }`) and
  `<plugin>/skills/<path>`, never a package's hooks, commands or MCP servers. Every skill folder, and the
  folder of any `SKILL.md`, must be lowercase words joined by single hyphens (else the package is
  refused). Every `SKILL.md` (at
  any depth) is written with the runner's own frontmatter, holding only `name` (its folder) and
  `description` (`canonicalSkillMd` in `apps/runner/src/skills.ts`). No other key (hooks,
  allowed-tools, model...) reaches the CLI, however the original is written: what the runner
  can't read stays as body text under its frontmatter, which can't end early (the description is
  one line with no `---`). Every `@` in the file becomes `＠` (U+FF20), so no file mention is
  expanded outside the read checks, whatever surrounds it. Every session runs
  with `disableSkillShellExecution`, so no skill or command runs a shell command as it loads. The files go under
  its state dir (`$XDG_STATE_HOME/dispand-runner`, else `~/.local/state/dispand-runner`,
  which may neither overlap a root nor the machine's config: checked when the config loads), in
  `sessions/<hash of the session id>/plugins`. Every file is created with `O_EXCL|O_NOFOLLOW`, then
  made 0444, and its folders 0555. Edits there are denied by the boundary (outside the working
  directory); reads are allowed. The SDK loads them with `skipMcpDiscovery`. They are written
  again at every start or resume and removed when the session ends and when the runner starts,
  so a changed copy never outlives its session.
- **Plugins bring files, never code that runs.** Marketplaces and plugins are fetched with
  `fetchGit` (`packages/domain/src/plugins/git.ts`): `https://` only (no credentials in the URL;
  `file://` only in a development build with `DISPAND_GIT_FILE_URLS=1`, for e2e fixtures),
  redirects not followed, no prompts, hooks, submodules, LFS or system and user git config,
  60 s and 200 MiB on disk at most (a limit kills git's whole process group), into a temp folder removed afterwards. Links are checked out
  as plain files (`core.symlinks=false`), then removed from the checkout and listed as not
  imported: nothing is ever written or read through one, and a file name that isn't UTF-8 refuses
  the fetch. Every file is read with `lstat`, any other non-regular file is skipped, and a plugin or skill folder whose real path leaves the
  repository is refused. An install imports only the components the owner ticks: skills, each
  through `validatePackage` (so `isSafeRelativePath`); agents, as a system prompt on the harness
  the owner picks (the agent file's `tools` and `model` are ignored); and HTTP MCP servers, as
  HTTP tools. A server is unticked until the owner ticks it with its URL shown, and is imported
  only as reviewed (its definitions at that commit, marketplace manifest included, else
  `CONFLICT`). Its `${VAR}` placeholders are filled from the owner's settings at install, then
  each header is sealed, and so is the whole URL when it holds one (shown as its template). A
  URL setting may fill only the path or query (never the scheme, user, host or port, which a URL
  rewrites) and hold only letters, digits and `. _ ~ -`, so the server sees it exactly as typed
  and it is redacted from what the server sends back like a header value. Settings elsewhere in
  a URL are out of scope: such a server is refused. Every insert path checks a tool against the
  same rules as the form (`insertTool`). Hooks, commands, `bin/`, MCP servers that run the
  plugin's own files (`${CLAUDE_PLUGIN_ROOT}`) and, until runner tools exist, MCP servers that
  run a command are never stored or run; all but the last are listed as not imported. A
  plugin's tools and agents can be edited but go only with the plugin, which can't go while
  something outside it uses one of its components. Updating a plugin moves its tools to a new
  URL only within the same origin, so saved headers never go
  to a host the owner didn't pick. Reading a plugin has one budget that every listing, read, MCP server and not-imported note
  is charged to (20,000 items, 64 MiB read; at most 200 skills, 100 MCP servers and 100 agents),
  so no shape of repository or manifest makes it do more. A plugin's skill package is read-only and goes with the plugin. Errors name what failed
  in a few words, never git's output.
- **Skill sites are read over https only.** A `.well-known` skill site's index and files are
  fetched with no credentials, redirects followed only to the same origin, within 1 MiB for the
  index, 2 MiB per file and 32 MiB and 60 s per read. A skill whose name isn't a skill name, or
  whose files include a path `isSafeRelativePath` refuses, is listed as not imported, and its
  files are never requested. Every other skill goes through `validatePackage`.
- **Every input is validated** by its procedure's Zod schema; errors don't leak internals.
- **One owner account per install; every row is owner-scoped,** and procedures only return the session owner's rows.
- **The server's secrets come from its environment** (`deploy/README.md`), never from git,
  logs or client bundles.
- **Secrets entered in the app (API keys, tool headers) are sealed at rest** with AES-256-GCM
  under `DISPAND_SECRET_KEY` (`packages/domain/src/secrets.ts`, random 12-byte IV), and the
  AAD names their table, row and field, so a sealed value copied elsewhere doesn't open. They
  are write-only: no procedure returns them, sealed or not, only whether one is set. A failure
  to open one is a `SecretError` whose message holds neither the value nor the sealed text.
  A cloud harness's key is sent only to its base URL, which must be `https://` when a key is
  set (plain http only to loopback); listing its models follows no redirect, and a provider's
  error reaches the owner as a short reason, never its body.
  A cloud session opens the key at each model call and holds it only for that call: no
  `cloud_sessions` row, event, step error or log carries it, and a failed call ends the step
  with a short reason (refused key, rate limit, status code, unreachable host), never the
  provider's body. A cloud agent's tool calls (other than `ask_user` and `submit_outputs`, which
  Dispand answers itself) each need the owner's approval, shown whole, but for the actions the
  agent lets run unasked (above). "Always allow" on such an approval is the owner taking that
  action off the agent's asking ones: it holds for that agent from then on, until the owner
  puts it back, and no session keeps an allowance of its own.
  A tool's headers go only to its URL, which must be `https://` when it has headers (plain
  http only to loopback) and can't carry credentials itself. They are for the server they
  were entered for: changing a tool's origin (scheme, host, port) or its transport drops
  every saved header, and only those given with that change are kept, so the owner enters
  them again for the new address; MCP calls follow a redirect only
  within the tool's origin, and a failure reaches the owner as a short reason made by
  Dispand (host, status), never the server's answer. Whatever the server sends back (action
  names and descriptions, results) has the header values, and each word of them but a scheme
  name, replaced by "••••" before it is stored or shown. **Out of scope:** a server that sends
  them back transformed (encoded, split, reversed): it already holds them, and only the owner
  sees what it returns. A catalog entry that runs on the owner's machine (a runner entry) never
  takes a key in Dispand: the snippet it shows has placeholders, and the key stays in the
  runner's config. Dispand calls the URLs the owner
  enters (a tool acts as whatever account its headers authorize), except, in production, its own
  addresses: loopback, link-local and the subnets of the app's network interfaces (the Compose
  network with PostgreSQL), checked on the address each connection is made to.
  Tool steps call a tool from the server, with its headers, through the same connector and
  rules: an agent never gets a Tool step's tool or its headers, only the outputs a prompt or
  input wires to it. A Tool step runs only the owner's HTTP tools (looked up by id and owner at
  each call), and a call cut by a restart is never made again: its step fails.
  An operator with the database and the key can read them (see below).

**Who it defends against:** anyone on the internet calling the API or loading the app, and a
signed-in user trying to reach rows that aren't the session owner's. **Not defended against:** an operator with
access to the host, its database or the server's environment. Keep both lists true as the product grows: a reviewer
judges a finding by whether its attacker is in the first list.

A change that weakens any of these is a vulnerability.

## Supported versions

Only `main`.
