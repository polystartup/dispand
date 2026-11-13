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
  (`data` or `configure`), or declares it a Job's own tool (`inbox`, memory); every other procedure is declared "not a tool", and a test fails on
  one that is in neither list. No tool exposes secrets, runner pairing, user or session
  management, or anything that deletes a table or a field. Every call is authorized in one
  place: the Job must still be going, and the tool's bundle (for the memory tools, its own
  rule: `allowed` in `platform/tools.ts`) and every table the call touches must be in the
  Job's snapshot and still on the agent, so a right taken back applies at once
  and a right added later never reaches a running Job. A call then runs as the Job's owner; that
  identity is set only by the authorizing function, never from a request. These calls ask the
  owner no question: the bundles are the permission. `configure` changes fields, not the rows
  under them: a Job can't remove a choice of a field, since that clears the rows that use it.
  `configure` lists Jobs; a Job's transcript and definition hold whatever that Job read (rows,
  other transcripts, answers, from tables deleted since), so only a Job on every table reads
  them. A poll item's id (what the tool read) is never shown to a Job. Deleting an agent keeps
  its Jobs, their transcripts, Questions and Approvals (only its configuration goes): a Job still
  going is stopped first, and a Job whose agent is gone has no agent to authorize it, so its token
  is refused and it never runs again; it is read under the same rules as any other Job.
  Every call, a read or a refusal included, leaves one Audit row (`platform.call`) written by
  `callPlatformTool` after the call: the tool's name, the reason code of a refusal, and only ids
  the server resolved (a table of the owner's within the Job's, what the call created or
  returned); never the call's input or output, and a failure to write it never changes the
  call's result. `configure` reads the Audit (`audit_list`), without the rows naming a table
  outside the Job's (left out in the query, so a page and its cursor say nothing of them); the
  trace link's address (`audit.traceUrl`) is the owner's only. How long Audit keeps its rows is the owner's
  only too: shortening it erases the trail of what agents did, so its procedures are no tool
  and no proposal can carry them.
- **A session gets its agent's skills and tools, and no more.** For a Job, what its snapshot
  holds and the agent still has; for a workflow run, the agent's as they are. A tool reached by
  URL is called on the server only, for cloud sessions, with its sealed headers opened for that
  call: a session start never carries a tool's address or headers, only the names of the
  runner's own MCP servers the agent was given (and only those of the harness's runner). Every
  call of such a tool asks the owner first, in a cloud session as on a runner. A cloud session's
  `read_skill` reads only a file of a skill in those packages, checked again at each call, by
  its exact stored path inside the skill's folder (an unsafe path is refused, nothing is
  decoded): it reaches no other package and no file on the server.
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
  server, the tool's name and the action's name and description in full. Managed actions ask in
  `bypassPermissions` mode too, unless the agent already has permission to run them without asking. Every call a Job makes of such a tool, in a
  cloud session or through `/mcp/job/tools` (a call refused for want of an approval included),
  and every poll leave one Audit row (`tool.call`, `poll.run`) written after the call: the tool,
  the action and how it ended, and for a poll its status and how many new items it recorded;
  never the arguments, the result, an item or its id, and a failure to write the row never
  changes what the call returns.
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
  sent unless `OTEL_EXPORTER_OTLP_*` names a collector, and then only there. Log records are
  also printed to the process's output, through the same redaction.
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
  (`propose`: at most 60 configuration writes and 64 KiB, each validated by its tool and kept
  as parsed), and belongs to its Job: no other Job uses it, and it ends with the Job. An item
  creating or changing an agent also freezes each chosen tool's unasked actions when prepared:
  the owner reads that list, and execution writes that list, even if defaults change meanwhile.
  Explicit `toolPermissions` are part of the exact matched input; defaults and retained grants
  are saved alongside it. Old unconsumed agent items with tools but no recorded permissions
  must be proposed again. Plugin setup uses the same snapshot and checks a digest of its
  preview before making any writes, so a changed list requires another review.
  The snapshot binds the grant to the tool's target and permission revision; retargeting
  increments the revision atomically, including when pointed back later. Agent writes check
  the binding while holding a shared lock on the tool, so retargeting cannot restore an old grant.
  An item
  may name what an earlier item of the same proposal creates (`{ "$item": n }`, where an id
  goes); it matches a call only with the id that earlier item's own call created, recorded
  when it was used, so a reference can't be pointed at anything else. `proposal_apply` makes
  an approved proposal's unused items in order, each through `callPlatformTool` as that very
  item, with the Job's rights read again for each: it can do nothing the Job couldn't do by
  calling them itself, and stops at the first refusal. A proposal naming a business has what
  its items created listed in a generated plugin, which owns none of it (no `plugin_id` is set),
  so removing that plugin deletes nothing else. An item is used up when its call
  starts, whether or not the procedure then accepts it. The Job's rights are
  checked first and as they are at the call, so an approval never brings back a bundle taken
  since, and the procedure's own checks still apply (what isn't the owner's stays refused). A
  person may approve more than the proposing agent holds: that is what a grant is, and why
  the owner is shown every item whole. The agents an agent may consult, and its description
  (which agents that may consult it read), change the same way: a person on the agent's page,
  or an approved `agents_create` or `agents_update` item. An entry pairs only two agents that
  both have `configure` or neither has, and never an agent with itself.
- **A consult reaches only an agent its Job may consult, and nothing answers in that agent's
  place.** A Job's `consult` tool (cloud and runner sessions; absent when its agent may consult
  none, and in workflow steps) names an agent by id. A runner sends a consult only for an agent
  its session's start listed, so a session never names one the server didn't offer. At the call the engine checks that the entry is in
  the Job's snapshot and on its agent now, that the pair still passes the `configure`
  rule, that the agent isn't already higher in the same chain of consults (A asks B, B asks A),
  and that the root isn't stopped (`engine/consults.ts`); a refusal is the answer. An entry
  flagged "ask before use" in either raises one Approval, showing the question whole, and no
  Job is made before a person's yes (a question too long to show whole is refused); a no is the
  answer, and a person's "don't ask again" takes the flag off the entry. That Approval is the
  consult's: its answer reaches no session, and only a person answers it. The
  consulted Job is a Job of its own agent, with its own snapshot and rights, created in the
  asking Job's root (it counts toward the checkpoint) and told the question, the asking
  agent's name and Job id, nothing else. Its result is the answer, recorded by the engine as
  that agent's; the same rights are checked again before the answer is sent, every time it is
  sent, and a right taken back turns it into the reason. A change on the agent's page or by an
  approved proposal that takes a right back (an entry removed, a flag added, a bundle change
  across `configure`) ends every consult in flight it touches in the same transaction: its
  consulted Job stops, and the asker gets the reason, also in place of an answer recorded and
  not yet delivered. A consult is a `questions` row of kind
  `consult` that no person and no `inbox` agent answers: the Inbox, its count, `questions.answer`,
  the `inbox` tools and approvals all leave it out, and it records no interaction event.
  Stopping or failing the asker stops its consulted Job, and so on down the chain. Accepted:
  through a pair a person approved, what the asker read can steer the consulted agent within
  what it does without an approval, and the answer can carry what the consulted agent read.
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
- **A Job writes memory only where its agent's self-learning says, and only as itself.** The
  memory tools (`memory/tools.ts`) are the Job's own: `memory_read` reads the workspace's
  memory, its own agent's, its tables' (with `data`) and another agent's only with
  `configure`; `memory_add`, `memory_update` and `memory_remove` write the scope whose target
  the Job's rights hold (`agent`: its own agent's memory only; `data`: a table within its
  tables, with `data`; `workspace`), checked at every call with the rights as they are then.
  Setting the targets is a grant (part of `agents.create` and `agents.update`). Every write goes
  through `memory/store.ts`, which checks the entry and its path (`isMemoryPath`: never a file
  a CLI loads as instructions) and keeps each revision with its author: the agent, its Job and
  whether it had `configure`. `memory_add` never replaces an entry and `memory_update` never
  creates one, and the owner can revert or restore any write.
- **Memory steers the agents that work on data, never one that configures until a person
  accepts it.** A Job's session start gets, after its agent's instructions, the memory it reads
  (`memory/read.ts`, read whenever a start is sent, first, again or resumed, with the Job's
  rights as they are then, and never kept in the stored start): the
  workspace's, its own agent's and, with `data`, its tables'. An entry whose current revision a
  Job without `configure` wrote, and no person accepted since, is never in the prompt of a Job
  that has `configure`: that Job is told how many were left out and reads them with
  `memory_read`, as information marked with its author. On a runner, the same reading also
  goes in the start as files (`memoryFiles`, filtered alike), which the runner writes read-only
  under the run folder's `.dispand/memory/<scope>/<path>`, emptied at every start or resume and
  removed when the session ends (`apps/runner/src/memory.ts`): it checks every scope and path
  again (`isMemoryPath`, so never a name a CLI loads as instructions, nor a `.claude` or
  `.mcp.json` segment) and refuses the session on one that fails, writes or removes nothing
  unless `.dispand` is a real folder, makes every folder below it itself and creates each file
  with `O_EXCL|O_NOFOLLOW` (a file whose place is taken, or whose name the file system can't
  hold, is left out). The files are what the prompt already says, so the session reading them
  gains nothing; memory is written only with the memory tools. Accepted: while a Job's session
  runs, a Codex session of another Job on the same runner can read its memory files, as it can
  read the rest of that run folder (Codex's sandbox reads everywhere but the machine's config,
  above). A person's write needs no acceptance; an agent's write clears it. Accepted: an entry written by one Job instructs the Jobs without
  `configure` that read it (the workspace's reach every agent's Jobs), within what those Jobs
  may do without an approval; the owner sees, reverts and removes any entry.
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
  kind of its chat, or dropping its platform skill, in the owner's procedures and in a
  proposal's items alike. The platform skill is the application's: its files come from the
  build, nobody can change or delete the package, and each start puts the build's files back.
  It holds no
  more than any agent given those bundles: its writes that grant go through proposals.
- **The server calls no address an agent chose before a person approved it, and an agent
  never handles a tool's credentials.** An agent adds a tool only as a proposal item:
  `tools.add` (a name, a URL and a transport, nothing else; a URL with credentials or any
  header is refused when proposed), or `tools.addFromCatalog` (a catalog entry's id and a name:
  the entry's own address, with no header value; a runner entry is refused when proposed).
  Making the proposal fetches nothing: the address is first contacted, to list its actions,
  when the approved call runs. The owner reads the address whole with the host set apart (a
  catalog entry by its name and address), and enters the server's headers afterwards on the
  tool's page (a catalog entry's settings, `tools.fillSettings`, sealed in the headers its entry
  names, or its OAuth sign-in). A catalog tool added this way starts with the actions its entry
  declares, so their flags and poll triggers can be approved with it; until its settings are
  filled (or, for OAuth, it is connected) it "needs sign-in": nothing calls it, lists it or
  polls it (`connectionTarget` and the scheduler refuse before any request), since some servers
  answer without a key. Agents can read tools (names, addresses, actions, header names, never values) and
  delete an unused one through a proposal; changing a tool's address, transport or headers
  is not one of their tools at all.
- **A proposal is approved by a person, on what the server shows, never on the agent's words.**
  The agent asks with `request_approval`, naming the proposal's id. The server attaches a
  draft of that same run to the question with one conditional update (so a proposal has one
  question and one answer), and the owner's answer to that question, given through
  `questions.answer` as a signed-in person, approves it; a denial declines it for good. The
  Inbox and the chat read the items from the server's row and shows each whole, with a name for every id
  an item points at (the agent, the harness, tools, skills, tables, a field with its table)
  as resolved for that owner; an id that names nothing of theirs is flagged. Which values of
  an input are ids is the server's own table per tool: any other value is shown as data. A question for a proposal is not
  answerable where its items aren't shown: a run's view carries them (`runs.get`, `runs.stream`), and the chat shows them whole with an Approve control in its composer, only while that question alone waits in the chat (with several, each card has its own controls, so a click never answers another than the one read); when they can't be shown there, the chat sends the owner to the Inbox. Words typed in the chat while it waits decline it, whatever they say, and reach the agent as the reason. A request
  naming a proposal that isn't attached (another run's, one already asked, none) is words only,
  and says so. A `proposal` argument that isn't an id is refused as a bad call by the runner
  and by cloud sessions, so it never becomes a request in words in its place.
- **Workspace-wide availability is the owner's choice.** `tools.disabled` masks action names
  before agent permissions are listed or exposed to a session. Only the owner's tool-settings
  API can change it; it is unavailable to Jobs and setup proposals. Disabled actions are
  refused by current tool calls and workflow steps; polls skip them with a reason. Disabling
  narrows live runner sessions, including tools inherited through skills. Re-enabling restores
  saved per-agent Run/Ask/Off settings; a running native session only narrows, so it needs a new
  session to regain an action. New discovery actions remain enabled and Ask for existing agents.
  Disabled names survive temporary discovery omissions. Catalog entries may supply initial
  disabled names. Availability changes invalidate previously frozen setup grants through the
  tool's permission revision, so an old approval cannot override the new availability.
- **Remembered tool decisions have a server-owned subject and scope.** The storage helper
  `agents/remember.ts` accepts a pending question id and the owner's decision, never a subject
  supplied by a client. It requires the question's explicit server offer, an owner answer, a
  live run, the same agent, current action access, and an unchanged tool target/permission revision. It refuses
  proposal, checkpoint, consult and general approval questions. Run decisions are isolated in
  `runs.remembered`; future-run choices update the Job agent's existing action permission.
  Effective tooling applies run memory only to that agent and target: an allow never adds a
  tool outside current access or a Job snapshot; current Off/workspace restrictions and a
  run-level deny override allows. Run memory does not affect another agent in a workflow.
  Workflow questions cannot persist a future-run choice. The answer transaction validates the
  offered scope before marking the question answered; remembered allows consume that approval,
  so revoking the grant cannot leave a spare single-call approval. The UI defaults to Just this
  call, offers run-only memory, and offers future-run memory only for a Job's chosen agent tool.
  Allow + future-run selects Run; Deny + future-run selects Off. Agent answers cannot remember.
  Legacy Always is refused for MCP tool questions. Undelivered positive answers are checked
  again before they may populate a runner's local cache.
- **Which actions of a tool run without asking is the owner's choice, per agent, and only a
  person changes it.** Each agent keeps, for each tool it chose, the actions that run unasked
  (`agent_tools.unasked`) and those that are off (`agent_tools.denied`). An Off action is
  excluded from cloud specs and the Job tools endpoint, and refused at call time; every other
  enabled action asks as above. Both callers read current permissions at each call (an action put back asks from its next
  call on, in Jobs already running). The list starts with the actions the tool's server calls
  read-only (`readOnlyHint`) when a person adds the tool to the agent, or, for a tool installed
  from the catalog, with the actions its entry names that the server lists then (runner entries retain their declared names before discovery; `defaultUnasked`
  in `tools/catalog.ts`: Dispand's own choice, shipped with the code; an action the entry doesn't
  name asks, whatever the server's hint, so a catalog server can't make an action run unasked by
  calling it read-only; a tool pointed at another
  server or runner tool is no longer its entry). That hint is the
  server's claim and is read only then: a server that later calls another action read-only
  gains nothing, an action that appears later asks, and a tool that only comes with a skill
  asks for everything. A tool pointed at another address or transport asks for everything
  again on every agent for enabled actions: the unasked list named the old server's actions. Tools reached by URL and runner tools
  have this list; runner tools use it in Job sessions only. The list changes in three ways, each a person's: the owner on the
  agent's page; an item of a proposal the owner approved (the write is a grant: an agent
  can list it, never make it on its own); and the answer "always allow" to an approval of
  that action, in a cloud session or a Job's CLI session. For a CLI session the server resolves
  the name the question was asked under (which stands for one tool and action for good) on
  the run's own agent; a name that stands for nothing the agent chose grants nothing, and the
  runner is then told "allow", once. On "always", the runner only stops asking about that
  name of the Job's tools server in the session that asked. So no agent removes its own questions. Accepted: an unasked action that reaches outside (a search,
  a fetch) can carry in its arguments what the Job read; the owner keeps such actions asking
  on agents that read confidential tables. An unasked action also runs for a session in
  `bypassPermissions` mode. Run/Ask/Off changes keep the two lists disjoint under a row lock;
  a late Always answer cannot re-enable an Off action. Off names remain saved if discovery
  temporarily omits them, even when another permission changes. Unrelated agent updates preserve both
  lists, and an explicit unasked list that would restore an Off action is refused. Enabling an
  action selects Ask; changing it to Run is a separate grant. Runner denials are sent to live
  Job and workflow sessions, including after reconnect; re-enabling applies in a new CLI
  session because a running one only narrows its permissions.
- **The runner is told which of the Job's tools run unasked, and that only spares prompts.**
  A Job's session start may carry `unasked`: names of the tools endpoint's tools (at most 500,
  each at most 48 characters of `a-z0-9_-` with no `__`). The runner makes the CLI's tool names
  itself, `mcp__job_tools__<name>`, and lets those run without a question, on a session that
  has a Job token only. Runner refs may separately name unasked actions on their own locally configured MCP server: agent or run grants for Jobs, and explicit run grants for workflows (protocol 19). Neither list can name commands, file tools or another server's tools. Whether
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
  server's tools and the agent's explicitly unasked MCP actions run without a question on a runner; every other MCP tool still asks. A CLI
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
  (`allowBypass`, off by default). Claude Code always gets
  `disableBypassPermissionsMode`: the runner implements native command/file bypass through its
  approval broker so managed MCP calls cannot skip their per-agent permission checks. Unresolved
  file paths still ask the owner. Sessions load the user's own Claude Code settings only,
  never a run folder's `.claude/` settings, hooks, `.mcp.json` or `CLAUDE.md`, on start or
  resume. Claude Code and Codex run as the runner machine's user, with that user's own profile:
  its settings, instructions files, memory, hooks and sign-in. Agents on that runner therefore see
  and use that profile, and whoever pairs a runner chooses that user.
  The server URL must be `https://` (plain http only to
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
  (Codex's `:danger-full-access`) needs `allowBypass`, as for Claude. Approval policy stays
  `untrusted`; the runner automatically approves native commands without additional permissions
  and file changes that pass its protected-path checks.
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
- **Native plugins are an explicit runner-local opt-in.** The owner-authenticated `runners.plugins`
  and `runners.workspacePlugin` procedures check runner ownership and CLI harness membership. They
  reject Job contexts and are absent from management tools. Protocol 15's native requests run only
  the maintained Skillshare executable on the runner, from its home directory, with explicit global
  scope and target/account names from local `pluginTargets`. The server cannot set commands or
  account config paths. Complete plugin sources are credential-free HTTPS Git URLs, pinned to the
  workspace source commit and entry identity; no server-selected local paths or other transports.
  Standalone workspace packages use `add-workspace`: bounded package-relative files, staged
  atomically under the runner state directory at
  `native-skills/<native-name>/<digest>/<native-name>/`. The session writer checks paths and
  rewrites frontmatter, producing only a skills directory and its own manifest. The staged source
  persists for Skillshare's reinstall lifecycle; it stays outside roots and cannot change CLI
  settings. Mutations select explicit targets and require a preview revision. Complete native
  plugins may execute their native hooks, commands and MCP integrations: opting a target in
  authorizes that native lifecycle, separately from sanitized workspace imports. Skillshare config,
  data and state directories join the machine paths excluded from roots and session access. Custom
  account config directories must be outside roots and protected locally like CLI homes. Native
  replies expose a bounded projection, never raw paths, identifiers or error text. One operation
  runs at a time, with bounded output and time; failures and partial outcomes are reported, never
  automatically retried. Removing a native binding does not change workspace imports. Registration
  does not imply successful resource loading. On each start/resume the runner omits a workspace
  package only for a matching source key associated with its workspace entry: repository URL,
  resolved commit and entry, or the standalone package content digest. The native binding must be installed,
  enabled and free of pending operations or changed account/source context on that session's
  harness. Missing, disabled, unknown, mismatched or unavailable native inventory retains the
  stripped workspace copy. Native execution failures never trigger automatic fallback or retries.
  The locally authorized Skillshare target must name the same CLI account sessions use.
- **Workspace plugin imports bring files, never code that runs.** Marketplaces and plugins are fetched with
  `fetchGit` (`packages/domain/src/plugins/git.ts`): `https://` only (no credentials in the URL;
  `file://` only in a development build with `DISPAND_GIT_FILE_URLS=1`, for e2e fixtures),
  redirects not followed, no prompts, hooks, submodules, LFS or system and user git config,
  60 s and 200 MiB on disk at most (a limit kills git's whole process group), into a temp folder removed afterwards. A plugin in the
  Agent Plugins layout (a root `plugin.json`) is read with that standard's rules. A schema-less root object may use the Claude loader when a named Claude manifest exists; explicit schemas never fall back. Both loaders run under the same
  limits: its `$schema` ids are known, never fetched; a linked `plugin.json` rejects it; its
  stdio servers are read (a `./` command and `cwd` that stay inside the plugin, or a `cwd` in
  its data folder) but, like every command a plugin names, never stored or run. Its `com.dispand`
  definitions (tables, agents, triggers) are data and grant nothing: install only stores them,
  each read as a regular file within the same budget and checked alone. What is made from one is
  made by the procedure a direct call uses, by the owner or through an approved proposal, with
  that procedure's checks. The owner's setup (`plugins.setUp`) makes the items a proposal would
  list, each through its procedure with the owner's own session, and binds to what an earlier
  setup made only by the id it recorded, never to a table by its name. An agent made from a
  definition is a copy with no link to its plugin, made by `agents.create` with the bundles,
  tables and self-learning the owner reads in the item, so its consults pass the same pair check
  as any agent's; an update replaces the definitions and never what was made from
  them. Links are checked out
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
  plugin owns only its record and its skill package: removing it keeps its tools (with their
  saved headers) and agents (with their Jobs) as the owner's, and deletes its package unless an
  agent uses it, which then stays as the owner's own. No foreign key to `plugins` cascades to
  the owner's data (`db/cascades.test.ts`). Updating a plugin moves its tools to a new
  URL only within the same origin, so saved headers never go
  to a host the owner didn't pick. Reading a plugin has one budget that every listing, read, MCP server and not-imported note
  is charged to (20,000 items, 64 MiB read; at most 200 skills, 100 MCP servers and 100 agents),
  so no shape of repository or manifest makes it do more. A plugin's skill package is read-only while the plugin is installed. Errors name what failed
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
  agent lets run unasked (above). The owner may remember a decision for the run or, when offered,
  for the agent's future runs. The engine stores it from the server-resolved tool key; no cloud
  caller writes permanent permissions independently. The obsolete session allowance column is
  removed; current permission policy is read at every call.
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

Runner tools in a Job may run only the actions its agent or the owner's run decision marks unasked; workflow runner refs carry explicit run grants only. The runner derives fully qualified MCP names from its own configured servers; these grants never name shell or file tools. Live permission updates only intersect existing grants, including on reconnect and during startup. Server aliases bind a tool id and its runner target, so removing or renaming another tool cannot reassign a grant. A persistent approval must still name that target and its current permission when delivered; a revocation invalidates pending local permission caching. Automatic runner calls use the same protected-path argument guard as polls. Server-side changes reach workflow sessions as well. Catalog runner tools with empty action permissions receive their catalog defaults once during the approved upgrade; non-empty lists and HTTP tools keep their permissions.

**Who it defends against:** anyone on the internet calling the API or loading the app, and a
signed-in user trying to reach rows that aren't the session owner's. **Not defended against:** an operator with
access to the host, its database or the server's environment. Keep both lists true as the product grows: a reviewer
judges a finding by whether its attacker is in the first list.

A change that weakens any of these is a vulnerability.

## Supported versions

Only `main`.

Native installation identity records the resolved Git root at import and update. Only verified
root plugins currently support native installation; older imports must be updated, and nested
plugin imports keep their workspace skills. An explicit native-install intent requires the
preview review token even when workspace components are also selected. Codex's local plugin
cache, marketplace code and skills directories are readable in its sandbox; its parent config
directory, settings and credentials remain denied, and native code is never writable by the session.

### Runner updates

Installer-managed runners poll the authenticated `/runner/update` control channel independently
of the session protocol. Only the signed-in owner can request an update of their runner.
An update executes the existing installer from the runner's locally configured server (no
redirects), in a transient systemd user unit so it survives restarting the runner. The server
cannot supply a command, URL or local configuration through the update request. As with the
initial installation, the configured Dispand operator is trusted to supply runner code.

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


A finished Job chat may continue only after success and only with recorded transcript history.
Reopening creates a new owner chat root and session id in the same transaction as the message,
rotates the Job token hash and sealed value, and records an owner `job.reopened` Audit row.
The old token never regains authority when that Job becomes active again. Late events still
name the old session and cannot finish the reopened Job. Protocol 22 acknowledges a requested
stop only after the process exits and its session cleanup finishes (or when it is absent);
the new CLI session waits for that acknowledgement or reconnect proof of absence. This wait
is durable across server restarts. The resumed session retains its transcript but reads
current tool permissions and its fresh token. Cloud transcript inheritance is restricted to
the same owner and step. Failed or stopped Jobs and workflow runs cannot be reopened.
