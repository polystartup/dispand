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
  (`data` or `configure`), or declares it a Job's own tool (its own inbox, memory); every other procedure is declared "not a tool", and a test fails on
  one that is in neither list. No tool exposes secrets, runner pairing, user or session
  management, or anything that deletes a table or a field. Every call is authorized in one
  place: the Job must still be going, and the tool's bundle (for the memory tools, its own
  rule: `allowed` in `platform/tools.ts`) and every table the call touches must be in the
  Job's snapshot and still on the agent, so a right taken back applies at once
  and a right added later never reaches a running Job. One exception, which we decided: a table
  a Job creates (`tables_create`) joins its agent's tables and that Job's own, where each is a
  list, in the transaction that makes it, so the Job gains rights on exactly that table and
  nothing else (no other table, no bundle); a refused create adds nothing, and both rows are
  locked so concurrent creates each keep theirs. A call then runs in its run's workspace, with a
  member's role at most; that identity is set only by the authorizing function, never from a
  request. A procedure only a workspace's manager may call (a harness's settings or limit, so
  far) a Job reaches only to make an item of a proposal, and only while the person who approved
  it still manages the workspace, read when the item is made. These calls ask the
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
  served with a Content-Security-Policy that keeps scripts and stylesheets (plus inline ones),
  images (plus inline `data:` and `blob:`), media and fonts to the app's origin, connections
  to it too, and allows no frame, object, foreign `base` or form target, nor being framed
  (`server/page-security.ts`). Text an agent wrote is shown in many places; whatever a
  renderer makes of it, the browser can't be made to fetch from, or send to, another host. A
  served file keeps its own stricter policy (`default-src 'none'; sandbox`). The one
  exception is a generated artifact the owner chose to run (below).
- **An agent's text is shown formatted, and loads nothing.** In the chat and in a Job's
  transcript on its run page, an agent's words go through one component (`components/chat/AgentText.tsx`): an image shows only when its
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
  preview before making any writes, so a changed list requires another review. Every plugin
  install carries the `reviewed` token of the preview the owner read (its commit, servers and
  definitions), whatever it picks, so a skill's files or an agent's instructions pushed since
  are refused. A plugin install
  set up from its install sheet, or from an approved `plugins_install` item, shows no item list:
  every tool it gives an agent starts on Ask, it adds no plugin server the install didn't tick,
  and a poll of an agent it makes waits. A `plugins_install` item carries the `reviewed` token
  of the plugin as `plugins_preview` read it (its commit, servers and definitions), so a commit
  pushed meanwhile is refused; it picks skills and definitions only: MCP servers (their
  addresses and settings), agent files and native installs stay the owner's to add. When it is
  proposed, the server reads the plugin again, refuses a token that isn't that read's, and keeps
  the picked agents' rights with the item (`shown`): the owner reads those, never a page fetched
  on its own, and the token makes them what is made. Only a Job on every table proposes it, as
  its setup may reach any table. An agent adds a marketplace or a skill site (`marketplaces_add`)
  only on an approved item, like any grant: the item holds the exact address and kind, so an
  approval for one address never adds another, and the owner reads the address as the server
  will read it (`shown`: GitHub's `owner/repo` made whole, a skill site's index URL; nothing is
  fetched before the approval, and an address that isn't https, or holds credentials, is refused when proposed).
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
  "Let Stem deal with it" hands an update's conflicts to one Job of the Assistant that holds a
  single tool, `plugin_decide`, and nothing else of Dispand's (no row, configuration, proposal or
  memory tool, no skill, installed tool or consult), because its prompt carries the plugin's new
  text: whatever that text says, the Job can only decide the fields handed to it. A decision
  applies only while the field still holds the owner's value and the plugin's value it was handed
  off against; a decision that is neither value, or that changes an agent's rights (they combine,
  so two decisions within bounds could give together what neither version did), waits for the
  owner's Approval: one Approval in the Inbox per update, each value answered on its own by the
  owner (never by an agent, never whole), applied only while the field still holds the owner's
  value it was decided on, else that value is the owner's to decide again; a tool it gives an
  agent starts with every action on Ask. A plugin's table handed to it is decided as a list of
  the change keys the update showed (any other key refuses the whole decision); a change that
  removes values never applies without the owner's yes on that Approval, which shows the field's
  values, and it applies in one transaction under the table's lock that every field operation
  and row write takes: planned again (a change gone stale is skipped), claimed as the owner read
  it, and only while the field still holds exactly those values (any difference asks again). A skill's file handed to it is decided like
  any wording field: its merged text waits for that Approval unless it is one of the two files,
  and a decision or an answer writes it only in one transaction under the package's lock, while
  the owner's file and the plugin's are still the ones it was decided on, checked as a whole
  package like any edit. The Job is
  given the changes' keys and counts, never a row's value. On a runner it runs
  as a restricted session (protocol 26; on Codex, protocol 29), on Claude Code or Codex: the runner itself gives it no skill, memory or consult, no MCP
  server but the Job's own, and no way to the shell, files or network, whatever the start holds. On Claude Code: no
  built-in tool (nor the CLI's server-side advisor, switched off in its environment) and none of the user's settings. On
  Codex (checked with 0.169.0 on what the model is sent, `codex/restricted-tools.test.ts`): every native tool a switch
  removes is off (shell, view_image, web search, image generation, browser and computer use, apps and plugins, subagents,
  goals, sleep, asking the person), as are hooks, memories, the skills catalog and every MCP server of the user's config;
  its turns get no execution environment, under a read-only profile with no network. What the model keeps is code
  mode's `exec`/`wait` (an isolate with no file system or network that calls only the tools listed here), `apply_patch`
  (the model's catalog entry adds it and no switch removes it: with no environment every call fails before touching a
  file, and a file-change approval would be declined), the clock, the MCP resource tools (which reach only the Job's
  server), `submit_outputs` and the Job's server. The runner answers no command, file-change or question request and no
  dynamic tool but `submit_outputs`, bypass or not. A restricted Codex start needs Codex ≥ 0.167.0 (`RESTRICTED_MIN_CODEX`):
  an older one may ignore a switch it doesn't know, so the runner refuses it. On any other one (from 0.167.0 up) it runs and the runner logs
  a warning: after every Codex update, run `codex/restricted-tools.test.ts` on the runner machine, and change the
  switches if it fails.
- **A consult reaches only an agent its Job may consult, and nothing answers in that agent's
  place.** A Job's `ask` tool (cloud and runner sessions; absent when its agent may ask nobody,
  in workflow steps and in a restricted Job) names an agent by id; an ask to an agent is a consult. Which agents it lists is the agent's consult
  mode: none (disabled), those a person picked (whitelist), or every agent the pair rule allows in
  its workspace (auto, at most 50 by name); auto widens what an answer may carry, so it is set only
  on the agent's page or by an approved proposal, which reads it out as every same-side agent. A runner sends an ask only to someone
  its session's start listed, so a session never names one the server didn't offer. At the call the engine checks that the agent is in
  the Job's snapshot and that the mode allows it now, that the pair still passes the `configure`
  rule, that the agent isn't already higher in the same chain of consults (A asks B, B asks A),
  and that the root isn't stopped (`engine/consults.ts`); a refusal is the answer. No Approval
  comes before a consult: picking the agent, or setting the mode, is the confirmation. The
  consulted Job is a Job of its own agent, with its own snapshot and rights, created in the
  asking Job's root (it counts toward the checkpoint) and told the question, the asking
  agent's name and Job id, nothing else. Its result is the answer, recorded by the engine as
  that agent's; the same rights are checked again before the answer is sent, every time it is
  sent, and a right taken back turns it into the reason. A change on the agent's page or by an
  approved proposal that takes a right back (an entry removed, a mode narrowed, a bundle change
  across `configure`) ends every consult in flight it touches in the same transaction: its
  consulted Job stops, and the asker gets the reason, also in place of an answer recorded and
  not yet delivered. A consult is a `questions` row of kind
  `consult` addressed to the consulted agent, once allowed, that no person answers: a person's
  Inbox, its count, `questions.answer` and approvals all leave it out, and it records no
  interaction event. Only a Job of that agent answers it: the Job started for it, by its end, or
  another Job of it through the inbox tools below, by the same engine path.
  Stopping or failing the asker stops its consulted Job, and so on down the chain. Accepted:
  through a pair a person approved, what the asker read can steer the consulted agent within
  what it does without an approval, and the answer can carry what the consulted agent read.
- **Whom an agent may ask outside a chat is a grant, and only members count.** Its "May escalate"
  mode (`agents/escalations.ts`) offers nobody (disabled, a new agent's), every member with a
  profile (auto, at most 50 by name) or the members a person picked (whitelist). Members are read
  live: the people `authorize` admits to the agent's workspace, its organization's owner included;
  a pick who left stays listed and is skipped, and a new pick must be a member. A plugin never names
  people: on whitelist its agent's list starts empty. Changing the mode, the picks or the agent
  preference is an agent update (a person on the page, or an approved proposal, which reads auto out
  as every member with a profile), and a plugin update changing them needs its confirmation.
  `agents.people` gives the members' names and whether each wrote a profile, never its text.
- **A question outside a chat reaches one person the rules allow, read when it is asked.** A
  Job's question to a person outside a chat (`ask` to a person or to nobody, `ask_user`,
  `AskUserQuestion`) goes through `firstHop` (`engine/routing.ts`): first to the person who
  started the run by hand, or for a Job of a person's Stem (their Assistant, which acts for them)
  to that person, while they are a member, whatever the mode (asking them isn't escalation); past them, or in a run no person started, refused at once with a fixed
  text when the agent's escalation is disabled now, whatever tool asked and whatever the Job's
  start listed; else the person `to` names only when the Job's start listed them and the mode
  still allows them, else the agent's creator (a workflow run's: the workflow's creator) while
  `authorize` admits them, else the organization's owner. A `to` that resolves to nobody is
  neither stored nor audited. In a chat, the person talking is asked, whatever the mode. Being
  addressed lets a person answer a question; it never grants a role an Approval needs.
- **Every use of an escalation checks its addressee again, live, first.** Listing it in an Inbox,
  answering it, and sending a push for it (each retry too) call `Engine.checkEscalation` in their
  own transaction: the rule of its hop is read again (escalation still enabled, the addressee still
  admitted by `authorize`, still picked or still the creator or the owner). When it fails, the
  question moves to the next hop (`question.rerouted`), skipping whoever was asked already, or is
  settled with a fixed text when escalation is now disabled or no hop is left
  (`question.unanswered`); then the use goes on, so a removed member neither lists, answers nor is
  notified of it. `engine/escalation-uses.test.ts` lists every such use and fails on a reader of a
  question's addressee that isn't one of them or doesn't say why. A membership change committed
  during a use applies from the next use: nothing locks against it. Each hop also has 72 h
  (`questions.answer_by`): the scheduler's sweep (`Engine.sweepEscalations`) moves a lapsed hop on
  the same way, so a person who left without a device to notify, or who doesn't answer, never
  holds a Job forever; once nobody is left, the Job gets a fixed text, answered by nobody.
- **Long work waits for a person; it is never cut.** The Jobs from one root cause pause at the
  workspace's checkpoint, and only a person's answer to its Approval lets them go on: no tool
  answers a question, and every path that makes a session work again reads the root's state
  first (`rootGoing`). A declined root makes no Job and none of its sessions works again, after a
  reconnect or a restart included. Changing the checkpoint is a grant: an agent does it only
  through a proposal a person approved.
- **What can't be undone, what removes a question and what starts Jobs are grants too.**
  Deleting a table, a field or an agent, changing a field's type, changing an action's asking flag, and creating, changing or
  deleting a trigger (what starts an agent's Jobs, and what the agent is told then) are in the registry with the same mark as
  creating or changing an agent, so the same gate refuses them without an approved item. One
  exception, which we decided because it only takes away what the agent does: a call that
  only turns off (`enabled: false`, no other field) a trigger of the Job's own agent runs
  without an item, checked on its parsed input against the trigger's stored agent, and leaves
  the same Audit row as any call; turning a trigger on stays a grant. A field's dry run
  (`fields_retype` with `dryRun: true`) only counts and changes nothing, so it runs without an
  item too, and can't be proposed. Deleting an agent runs the owner's own `agents.delete` (its
  Jobs still going stop, its triggers go), and is refused when proposed for the built-in agent
  (`assistantGuard`) and for the Job's own agent. Accepted: a consulted Job may propose deleting
  its asker's agent; applied, that stops the asker and so, down the consult chain, the
  consulted Job too, as any stop of the asker does. An
  item is also checked against the Job's tables when it is proposed, like any call: a Job
  limited to some tables can't put another table's deletion in front of the owner.
- **A trigger on Jobs gets no content.** A Job created, finished or failed is an event of
  ids, its cause's kind and its status, never its result, error or transcript, and the Job it
  starts is told only those and its agent's name, so any agent may have such a trigger without
  a bundle. Reading what the Job did stays `jobs_get`'s, under `configure` and every table. A
  Job's own agent is never fired by its event, and a chain of Jobs firing on Jobs stays in its
  root, so it stops at that root's checkpoint until a person approves.
- **Inboxes are per actor.** An agent reads only the questions addressed to it: its Jobs'
  `questions_list`, `questions_get` and `questions_answer` (`questions/inbox.ts`) run every
  call through one predicate (`questions/own-inbox.ts`, `ownInbox`): addressed to the calling
  Job's agent, asked in its workspace, its root going (an item held at a checkpoint is
  invisible), the asking Job and the calling one on the same side of `configure` by their
  snapshots, and not the Job started for it. Anything else gets "Not found". An answer settles
  the consult through the same engine path as the consulted Job's end, which checks the asker's
  rights again, settles only a consult still pending and stops the consulted Job in the same
  transaction. So no agent is fed another actor's questions. What remains is what an agent
  passes on in a question it addresses (to an agent it may consult) and the answer it gets back:
  inside a workspace everything is shared, and table scopes bound what an agent reads directly,
  not what it is told by an actor it may ask. Questions and Approvals start no Job: there is no
  trigger on them. A person may read an agent's inbox, read-only, in the Inbox.
- **A generated artifact's code requires access to its Job, and only `artifact_show` makes one.**
  The code lives in `artifacts` and leaves the server only through `artifacts.get`, which checks
  the parent Job's current workspace access and matches its owner to the artifact owner.
  Messages, snapshots, events, Audit rows and telemetry carry a reference (ids, title
  for the card, format, size) or less. A tool message gets an artifact reference only from
  `artifact_show` run by `callPlatformTool`: an MCP or native tool's result shaped like one is
  never stored as one. No route serves artifact code as a page.
- **An artifact runs only when its viewer clicks Run, alone in an opaque frame.** Before Run,
  the chat shows a card (title, format, size) and, on "Show code", the code as plain text:
  nothing of it is rendered as HTML, so no frame, script or request exists
  (`components/chat/ArtifactPart.tsx`). Run first says, in the app's own words, that the code
  may then send anything it holds outside Dispand; the click is not remembered. The code then
  runs in a `sandbox="allow-scripts"` `srcdoc` frame (Generative Frame, `opaqueOrigin`, pinned
  to an exact version): an opaque origin, with no cookies, storage or access to the page. It
  enforces Generative Frame's policy (no CDN, no connection, no nested frame, no `eval`) and
  inherits the page policy above, which still blocks other hosts' scripts, stylesheets,
  images, connections and navigation if the frame's own policy fails. WebRTC is the channel
  no browser's CSP covers: a running artifact could use it to reach a STUN or TURN server.
  That is why it runs only on a click. Its bridge to the chat gives it no tool; a prompt it
  sends only goes into the draft, which the owner still sends; a link opens only if it is
  `https:`, after the owner confirms its address, with `noopener`. Messages count only from
  the frame's own window. Expand exists only on a running artifact and mounts the same frame
  with the same options in a dialog under the app's own line saying the agent generated it and not to enter secrets
  in it; the frame is given the app's theme (colors and font), no data.
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
  creates one, and the owner can revert or restore any write. A memory write may also be an
  item of a proposal, refused when proposed outside the Job's targets; an approval never widens
  them. The built-in agent writes the workspace's memory by default (its `workspace` target,
  which the owner may untick), so what it learns steers every agent's Jobs: the business it
  writes on day one is an item the owner approves.
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
  answerable where its items aren't shown: a run's view carries them (`runs.get`, `runs.stream`), and the chat shows them whole. Each card's controls
  answer only its own Question. Only Approve grants the listed scope. Requesting changes
  declines that proposal with the supplied feedback. If the scope is unavailable, the chat
  directs the owner to the Inbox. A conversation draft cannot answer an Approval. A request
  naming a proposal that isn't attached (another run's, one already asked, none) is words only,
  and says so. A `proposal` argument that isn't an id is refused as a bad call by the runner
  and by cloud sessions, so it never becomes a request in words in its place.
- **A run reads its workspace's catalog, never its starter's.** A Job or a workflow run finds
  its agent, harness, runner, tools, skill packages, poll rules, remembered permissions, tables,
  rows, files, memory, consults, proposals and rights by its run's workspace, whoever in the
  workspace made them, and never reaches another workspace's, its starter's included (`engine/no-person-lookup.test.ts` lists every read of a
  run's person). A tool's headers act for the workspace. A change that takes away a grant
  narrows the live sessions of every agent of the workspace.
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
  call, offers run-only memory, and offers future-run memory only for a tool the Job's agent chose or gets with one of its own skill packages.
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
  asks for everything until a future-run answer, or the owner's Run/Ask/Off change for that
  agent (`agents.setToolPermission`, or an approved proposal item), changes it. That answer is kept in
  `agent_skill_tool_permissions`, one row per agent, skill package requiring the tool and tool
  id, with the tool's `toolPermissionTarget` it was written for: a row applies only to that
  agent, to that tool id (a same-named tool of a plugin or of the owner is another tool), while
  a package that gives the agent the tool is the agent's and still requires it (each answer is
  written for every such package at once, so it holds while any of them stays), and only while the tool's target is
  unchanged (another address, transport or runner tool, an availability change: by an edit, a
  reset to a plugin's value or a plugin update, the tool asks again). Removing the package from
  the agent, or the tool from the package, deletes its rows, and so does choosing the tool for
  the agent (its `agent_tools` row takes over, starting with a remembered Off, and removing it
  later revives nothing); an agent
  save that keeps the package keeps them. The write locks the package and its `agent_skills` row. A tool pointed at another address or transport asks for everything
  again on every agent for enabled actions: the unasked list named the old server's actions.
  That reset holds in both modes of the workspace's strict permissions (`workspace_settings.strict_permissions`,
  off until the owner turns it on in Settings; no tool or proposal reads or sets it). Off, a remembered
  choice (`agent_tools.unasked`, an `agent_skill_tool_permissions` row) is bound to the tool id and
  its target only, as above. On, it is also bound to a strict target, written beside its lists and compared
  only while strict is on, one rule for every reader (`heldUnasked`, `toolPermissionTarget` with versions
  in `agents/tool-ask.ts`): the tool's target plus its listed actions' names and input and output
  schemas, its plugin's commit, the skill package's files (`skill_packages.fingerprint`, for a choice
  that came with a skill) and the agent's `revision` (raised by every `agents.update`). A choice whose
  strict target differs, was written while strict was off, or can't be checked (the tool's last
  listing failed) asks again; its Off stays (a stale Off asking would widen). An explicit change
  under strict drops the stale grants of that tool rather than carrying them over. Turning strict on
  makes choices remembered while it was off ask; turning it off keeps every choice. A Job is held to
  the agent revision it was made from (its snapshot's), so a grant given after an edit doesn't reach
  a Job still running the earlier configuration. Polls read only grants that still hold
  (`tools/pollable.ts`). Turning strict on, and refreshing a tool's listing while it is on, narrows
  running sessions, as skill edits and plugin updates already do. A future-run answer under strict
  carries the strict target it was offered for (for a tool that comes with skills, each requiring
  package's, its files included) and is refused when it is no longer current. An agent update
  proposal freezes only the grants that still hold, each with the tool's strict target then (the
  agent's own revision left out, since the approval itself changes it); on approval a list is
  written only while that target is still current, otherwise a tool the agent had keeps its stale list (so it asks), and a tool it gains asks for
  everything rather than taking its current defaults. A run's own
  remembered decisions (`runs.remembered`) end with the run and carry no version. Tools reached by URL and runner tools
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
- **First-run setup creates the initial owner.** Sign-up is disabled; `auth.setup` (public) creates the
  owner only while no user exists, and only with the one-time code from the server's settings
  (`DISPAND_SETUP_CODE`), so the first-run window can't be claimed from the network.
- **Workspace membership management requires a signed-in person.** Organization owners and explicitly assigned workspace managers can inspect that workspace’s directory and remove explicit assignments. Removal preserves organization ownership and assignments in other workspaces. Roles are checked at use, with no lock: every request checks the caller's role live, and a directory write (an invitation, a removal, a runner registered or revoked for the workspace) checks it again inside its own transaction. A removal that commits while another manager's request is in flight doesn't undo that request: its writes stand, and the next request is refused. Runners are the workspace's: every member lists them, and only its managers register, rename, revoke or update one, whoever registered it; plugins and skills are installed natively on a runner only by the manager who registered it, since they run under its machine's account. Workflows are the workspace's: every member reads, edits, schedules, deletes and starts them; a run is its starter's (its schedule's runs, the workflow's creator's) and its chat, queue and stop stay with that person. A person's Inbox holds the Questions and Approvals addressed to them in the workspace they open, and its live count ends once their role there is gone. Agents are the workspace's: every member makes, changes and deletes them, with the workspace's harnesses, skill packages, tools and tables, whoever made those; each person's Assistant, and its chats, stay theirs. Triggers are their agent's: every member adds, changes and removes them, and starts the workspace's agents; the Jobs list shows the workspace's Jobs but other people's Assistant chats. Skill packages are the workspace's: every member makes, changes and deletes them, whoever made them. Tools are the workspace's: every member reads them, refreshes their actions, sets which run, and connects one by OAuth, or connects it again to another account, which shares that account with the whole workspace; a sign-in is finished only by the person who started it. A tool's address, like a harness's, is shown to every member: a credential goes in its headers or its OAuth sign-in, which are sealed and never returned, not in its URL. Only managers add, change (URL, transport, headers, settings) or delete one. Harnesses are the workspace's: every member reads them and picks one for an agent, and only its managers create, change or delete one, set its limit, or list the models of a runner or of a key typed in the form.
- **A workspace's tables are its members'.** Every member reads and writes its tables, fields, rows and the files in their cells, whoever made them, and uploads files to them; a live view of rows re-checks the person's role before every change it sends, and ends once the role is gone.
- **Workspace invitations require a trusted handoff.** A signed-in workspace manager or organization owner gives the single-use token directly to the intended recipient through a trusted channel after verifying their identity. Clients keep the token out of query strings and send it in an RPC request body. The database stores a digest. Reissuing an invitation replaces the previous token. It expires after seven days. Existing accounts must sign in with the invited email. A new recipient can preview the inviter, workspace and role after supplying the token and the matching email for an eligible new account. For a new account, only a handoff from the organization's owner permits password enrollment, checked when it is used, and only on a server that creates its own people (first-run setup on); a server whose people come from another flow enrolls nobody this way. A workspace manager can grant workspace access to an existing identity. The server checks the inviter’s current authority when the invitation is claimed. Acceptance grants ordinary organization membership and the specified workspace assignment, preserving existing roles. Removing an assignment also withdraws invitations addressed to that person or issued by them in that workspace.
- **A person's Assistant is theirs alone.** Other members neither see nor change it, its triggers, its chats or its memory, and no Job of another person reads its chats or memory. We decided that no Job consults an Assistant, whoever runs it, whatever the asking agent's consult mode, since a consult's answer lands in a Job the workspace reads; an Assistant still consults other agents. The check runs when a consult opens and again when its answer is delivered.
- **Workspace access to a job is checked against the current membership.** The job belongs to one workspace.
  Its organization owners can read it. Other organization members need an assignment to that workspace.
  A shared job link allows inspection of an agent job and the messages committed to its transcript,
  including a submitted message awaiting runner delivery. Editable queue entries and workflow runs stay owner-scoped. The server checks membership again
  before delivering subsequent stream events. Operations that still address records only by owner require current
  ownership of the installation’s sole workspace organization. A multi-workspace deployment must port each such
  operation to explicit workspace authorization before enabling it. Runner credentials and job tokens retain
  their separate grants.
- **Pages are each person's; memory is the workspace's.** A person's Home and pages, in each workspace, are theirs alone; their widgets show the workspace's tables, workflows and triggers (but other people's Assistants'), whoever made them. Every member reads and writes the workspace's memory, and its writes record who made them.
- **A workspace's settings are its managers'; an agent has its person's rights.** Every member reads the workspace's settings; only its managers change the checkpoint, the Audit's retention and strict permissions, and only the organization's owner its files limit. The Audit is read by managers. We decided an agent has the rights of the person it acts for, checked at each call: a Job a person started by hand, or a person's Assistant (its scheduled review included), passes a manager's procedure, such as reading the Audit (still limited to the Job's own tables' rows), only while that person manages the workspace; what a trigger, a schedule, a poll, an event or a consult fired acts for no one, whoever wrote the trigger. What a manager's Job reads, it may repeat in its transcript, which the workspace's members read: we accept it, as the manager chose to run it. What needs a proposal still needs one, made only while its approver manages the workspace. Each person's push devices are theirs.
- **A workspace's plugins and marketplaces are its managers' to change.** Every member sees the plugins installed in the workspace, its marketplaces and what an update or a removal would ask; only its managers add, sync or remove a marketplace, and install, set up, update, resolve or remove a plugin. Each plugin's elements are looked up in the workspace that installed it, never by the person who did.
- **A profile is written only by its person, as the session of the moment.** `profile.update`
  and `profile.get` are for a signed-in person and never a Job's tool, and write only that
  person's own `user.description` (at most 1,000 characters, no text in the Audit row). Like
  every procedure, they act as the session the request carries, not the one a page was opened
  under: a person who signs in as someone else in another tab, with a page still open, saves
  to the account now signed in. Accepted: it gives no one access to anything they could not
  already write. Each time the profile dialog opens it shows only a text it read, successfully,
  for the person signed in then; a dialog left open while another account signs in elsewhere
  keeps what it showed until it is closed.
- **The app is reachable only through the reverse proxy**, which terminates TLS and sets
  `X-Real-IP` to the peer it saw, overwriting what the client sent. That header alone is the
  sign-in rate-limit identity, so nothing but the proxy may reach the app's published port 3000
  (`deploy/README.md`): anything else reaching it could choose its identity.
- **Runners authenticate with a revocable token**, never a session. The token (32 random
  bytes) is shown once to the runner and stored as SHA-256; a pairing code is single-use,
  expires after 15 minutes and is stored as SHA-256 too. `POST /runner/pair` is public and
  answers the same 401 for unknown, used and expired codes, and reads at most 1 KiB of body
  (413 past it); every request body is capped at 1 MiB by the production server (11 MiB for
  `files.upload`, `skills.create` and `skills.update` only; a body without a length is refused). A runner is bound to its workspace before pairing.
  CLI job placement and runner access to job attachments and agent skills check this binding.
  An upgrade with conflicting legacy runner placement waits for an explicit database administrator
  assignment. Existing bearer tokens and pairing codes keep their values.
  Revoking a runner clears its token
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
- **The runner's container image runs each session's CLI in a worker of its own** (the sandbox
  contract, `apps/runner/src/sandbox/worker.ts`). The supervisor keeps the pairing token, the CLI
  logins, the permission broker and the path checks. Its workers are named by digest at build,
  started under gVisor (`runsc`, named on every launch: a missing runtime fails the launch), as
  the supervisor's own non-root user, on a read-only image, with no capability and no new
  privileges. Each mounts only its session's run folder (at the path the supervisor uses) and that
  conversation's transcripts (`<roots[0]>/cli/<runKey>`: Claude Code's `projects/`, Codex's
  `sessions/`); each CLI's home is a fresh tmpfs at every launch, so nothing a worker wrote
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
  no host address). Until it passes, the image starts nothing the server asks for, and its log
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
  them. In a session, the CLI starts the runner's own MCP proxy (`dispand-runner mcp-proxy`,
  `mcp-proxy.ts`) in its place, and the proxy starts it from the home folder, for Claude Code and
  Codex alike, never the run folder, where the agent could write files its command loads
  (`.npmrc`, `package.json`), with the proxy's environment stripped of every `DISPAND_*`
  variable plus its own `env`: the Job's token never reaches it. The proxy relays every message
  as it came, but a `tools/call` result in a Job's session: its files (images, audio, embedded
  resources' blobs) go to Dispand's files endpoint and the result gets the text naming the Job's
  attachments in their place (see the files paragraph below). The token reaches the proxy in its
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
  `setMcpServers` replaces a same-named user server for the session instead.
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
- **File downloads enforce the attachment's current scope and never run in the app's origin.** Each is stored at `<filesDir>/<ownerId>/<attachmentId>`, both ids made
  by the server: nothing from the upload or the tool's result (name, type, URI) reaches the path. They are reachable only through the app, at
  `GET /files/<id>`, which checks the signed-in user on each request and answers 404 for inaccessible ids.
  A Job's file requires current access to that Job. Other readers can download only attachments
  carried in the structured files of a committed user message in that Job's transcript.
  A queued message publishes its attachments when dispatch or steering writes that transcript
  entry, independent of subsequent runner execution. Held drafts belong to the uploader;
  raw tool-result bytes remain available only to the Job's authorized owner. Table files require the parent
  table’s single-workspace owner access, including after a table adopts a Job file. Downloads use no-store. A file
  is an image only if its first bytes are PNG, JPEG, GIF or WebP; only those are served inline,
  with that type. Everything else, SVG and HTML included whatever their name or declared type,
  is a download (`application/octet-stream`). Every file gets `X-Content-Type-Options: nosniff`
  and `Content-Security-Policy: default-src 'none'; sandbox`. A cell only holds files of its own
  table. Files are at most 10 MiB. Agents get no file's content but the files a person attaches
  to a chat message (below): no tool or prompt carries one. A Job with the `data` bundle sees a row's file names and
  ids, and can set a files cell to files already uploaded to that table (or empty it, after
  which the unused files are swept), like any other value of the row. Files in the result of a
  Job's HTTP tool call (images, embedded resources' blobs; at most 20 a result, each with the
  same bounds and sniffing as an upload) are stored as that Job's, and the agent gets their ids
  in place of the bytes. So are the files a Job's runner tools return: the runner's MCP proxy
  sends them to `POST /mcp/job/files` with the Job's token, which names that one running Job, so
  a stdio server can't put a file in another Job, and the path stays the server's own
  (`<ownerId>/<attachmentId>`). A result is kept or refused whole, with the reason in its text
  (what the agent sees, and the Job's transcript): a file over 10 MiB, more than 20 files, the
  Job's totals (200 MiB and 100 files over every file it keeps, from any tool, a file a table took
  included) or the install's (its owner's setting, 10 GiB until set, over every attachment). The
  check and the store run under one install-wide lock, so two results can't both fit a total only
  one fits; the proxy checks the per-result limits before sending, and the endpoint takes one
  result's worth of body (about 268 MiB) and no more.
  A Job can write in a cell only its own such files that no table has
  yet, which then become that table's for good (`writeRow` takes the writer from the call, never
  from its input): never another Job's, nor one a person writes. The bytes are stored as the
  server sent them. A reader must have the download permission for the file's current scope.
- **A file attached in a chat reaches only that chat's agent, and never as configuration.** The
  owner attaches files in any chat (`files.hold`, owner-only, refused to a Job, not a tool): each
  is held for them (no table, no Job), counted in the organization's total from then on, removed a day
  later if no message carries it. `runs.sendChat` gives the files it names to the message's Job
  in the transaction that writes the message (`takeChatFiles`: the owner's held files only, all
  or none, within 20 files of 10 MiB and the Job's totals, under the Job's files lock); a Job
  can't name any (`FORBIDDEN`). A cloud model gets them as image, PDF or text input, read from
  disk at each model call and never stored in its transcript; a PDF's pages are read by pdf.js in
  a child process with no environment, a 96 MB heap and 5 seconds, never in the server's own. A CLI session gets each one copied
  by its runner to `.dispand/attachments/<attachment id>/file<.ext>` in the run folder, every part
  made by Dispand (the original name gives only its extension, letters and digits); the original
  name is words in the message, never a path. Both the server (before it names a path,
  `chatFiles`) and the runner (`session.send`'s schema, then again before writing,
  `apps/runner/src/attachments.ts`) refuse a path that isn't `isAttachmentPath`: so never a
  `.claude`, `.codex` or `.mcp.json` segment nor a `CLAUDE.md`, `AGENTS.md` or
  `AGENTS.override.md` (in any case), which a CLI would read as configuration or instructions.
  The runner writes only through a `.dispand` and folders below it that are real folders, and
  creates each file from inside its folder (a child process that `chdir`s there and checks its
  real working folder first), so a live session swapping a folder for a link meanwhile sends the
  write nowhere else; files are created `O_EXCL|O_NOFOLLOW` and made read-only by descriptor. It fetches the bytes at `GET /runner/attachments/<id>` with its
  own token, which serves only a file a chat message carries, of a Job with a session on that
  runner. The child that writes gets no environment.
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
  the runner's bundled Skillshare executable by absolute path, from its home directory, with
  explicit global scope. Runner builds pin the upstream version and SHA-256 of each Linux release
  archive and ship its MIT license; dependency changes alter the runner build identity. Runtime
  never downloads or upgrades a dependency independently. The local installer’s `--native-plugins`
  option saves `pluginTargets: "managed"`; ordinary updates never enable native management.
  Absent targets or `{}` disable it, and explicit maps retain operator-configured accounts.
  The server and agents cannot change this local authorization. Once opted in, targets are managed
  accounts in the runner's own protected config directory, bound to the same local CLI homes as sessions.
  Personal Skillshare configuration is not edited. The server cannot set commands or account
  config paths. The runner installation directory, including bundled executables, is excluded
  from session roots. Complete plugin sources are credential-free HTTPS Git URLs, pinned to the
  workspace source commit and entry identity; no server-selected local paths or other transports.
  Protocol 24 carries the imported repository-relative folder for subdirectory plugins. The
  runner verifies Skillshare selects that folder for every requested harness before preview
  or apply. Source matching includes subdirectories and uses Skillshare discovery of the
  binding's immutable commit; failed discovery cannot suppress workspace skill fallback.
  Standalone workspace packages use `add-workspace`: bounded package-relative files, staged
  atomically under the runner state directory at
  `native-skills/<native-name>/<digest>/<native-name>/`. The session writer checks paths and
  rewrites frontmatter, producing only a skills directory and its own manifest. The staged source
  persists for Skillshare's reinstall lifecycle; it stays outside roots and cannot change CLI
  settings. Mutations select explicit targets and require a preview revision. Complete native
  plugins may execute their native hooks, commands and MCP integrations: the owner approves that
  native lifecycle by selecting its targets and clicking Install after the whole-plugin warning.
  The sheet then previews and applies that selected scope without reconfirmation; Skillshare’s
  revision check still rejects changed state. Workspace imports and native execution remain separate.
  Skillshare config, data and state directories join the machine paths excluded from roots and session access. Custom
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
  A locally overridden Skillshare target must name the same CLI account sessions use.
- **In the container runner, a native plugin runs in a conversation only when its agent holds a
  grant for it.** A workspace manager grants an agent native plugins (`agents.setNativePlugins`),
  never a member or a Job, even an approved one's, and each grant is an Audit row (ids and a
  count). Grants are separate from skill packages, and are read at each start and resume
  (`engine/tooling.ts`): a restricted Job gets none, and a plugin removed from the workspace takes
  its grants with it. A start names each granted plugin by the digest of its native revision:
  the whole plugin as an install or update read it (`plugin_native_files`), moved only by a
  person with the manager role or by a Job's proposal item a person approved (`movesNativePin`):
  a Job's own install or update never moves it, whatever its person's role; a plugin with no
  revision kept (too large, or imported before revisions were kept) is left out. The pin moves
  only after a screen that showed what the revision runs natively (`plugins/native-code.ts`): the
  install, update and approve-native screens list its hooks, its stdio servers' launches
  (environment names, never values) and the files they run, and an update or approval shows them
  against the pinned revision with every other changed file (markdown no hook or server names by
  path only, since its text is on the screen's other sections). Any change to the native revision
  makes an update stop on its screen, and the screen's token covers the whole revision, so one
  that moved since is refused. A runner gets
  a revision's files (`GET /runner/native-plugins/<plugin id>?digest=`) only while one of its
  agents, by its harness, holds a grant for that plugin in the plugin's workspace and that digest
  is still the pinned one, checked at each request. The supervisor keeps a revision under
  `<state>/native-plugins/<digest>` only after checking its files against the digest the start
  named (caps, safe paths, then the digest), written whole and read-only. Its safe paths are a skill
  package's, plus the plugin root's own `.mcp.json` (`isNativePluginPath`): a native revision is
  only ever the plugin's own read-only folder, never a workspace's; the store is cleared at
  each start. A worker mounts its conversation's plugins read-only at `/run/plugins/<plugin id>`,
  and nothing else of the store (`sandbox/native-plugins.ts`). A start names each plugin's
  servers Dispand manages as tools (protocol 39, `managedServers`): at each start the supervisor
  derives, from the unmodified stored files, the session's own read-only view of the plugin with
  those servers' declarations left out (`.mcp.json`, `mcp.json`, a manifest's `mcpServers` and the
  files it names), and a manifest references only files the filter wrote. That filter is a first
  layer; the guarantee is the check at use (`managedLoaded`): once a CLI has started a session
  (Claude Code's init message, Codex's `mcpServerStatus/list`, before its first turn), a server
  it reports loaded from a native plugin that is one of that plugin's managed servers stops the
  session before any turn, so only the relayed copy of such a server is ever used. Codex's copy,
  with its paths filled in, is held to the store's own size cap. The view also leaves out every hook that
  could answer for a permission (`PreToolUse`, `PermissionRequest`, in any case, wherever the
  plugin declares hooks), and drops whole a hooks declaration of a shape it doesn't read for sure:
  a plugin's hooks run in the worker, but never decide a permission, which stays the broker's.
  Every markdown file of the view keeps only the frontmatter that grants nothing (`name`,
  `description`, `argument-hint`), its body as it is, and one whose frontmatter can't be read is
  dropped: a plugin's skills, commands and agents never pre-approve a tool (`allowed-tools`),
  declare hooks or pick a model or a permission mode. A plugin's own MCP tools ask the owner
  whatever the plugin says of them (`readOnlyHint` or any other annotation): Claude Code through
  Dispand's hook, which answers `ask` for every MCP tool not of the agent's or the Job's servers;
  Codex, which runs a tool labelled read-only unasked otherwise, through the thread's own config
  the supervisor sets (`plugins.<plugin>.mcp_servers.<server>.default_tools_approval_mode =
  "prompt"`), with Codex's copy of each server declaration reduced to how it starts, so no
  approval setting of the plugin's overrides it. Claude Code loads each view
  whole through the Agent SDK's per-session plugins. Codex installs each view, before the first
  turn, from a marketplace the supervisor writes read-only beside them (`codexMarketplace`,
  `codex/native-plugins.ts`); its hooks arrive untrusted, and the supervisor alone trusts exactly
  the hooks of those plugins, by the hash it reads then (`hooks.state.<key>.trusted_hash`, written
  through the app-server), except those of events that can answer for a permission
  (`PermissionRequest`, `PreToolUse`), which stay untrusted: approving the CLI's actions stays the
  permission broker's alone. Codex's own manifest (`.codex-plugin/plugin.json`) is filtered like
  the others, and names the plugin when present. In Codex's copy, `${CLAUDE_PLUGIN_ROOT}` and
  `${CLAUDE_PROJECT_DIR}` in its server and hook declarations become the plugin's read-only mount
  and the session's folder (Codex doesn't expand them); `${CLAUDE_PLUGIN_DATA}` stays literal.
  Claude-format agents (`agents/*.md`) don't run on Codex. A restricted
  session gets no plugin on either CLI. In the image the grant alone is enough, with
  no local opt-in: the plugin's hooks and servers run inside the conversation's worker, which
  holds none of the runner's credentials, tools or other conversations. The bare install keeps
  the record below.
- **A runner runs a plugin's code only when its own record matches.** `allowedPlugins` in the
  runner's config, written on the machine only (`dispand-runner allow-plugin`, or by hand) and
  out of the server's reach like `mcpServers`, holds per plugin name the content digest and the
  launch entry. `allow-plugin` doesn't take the tool's page on trust: it fetches the files over
  the runner's token, refuses another name or a digest other than the one typed, shows the entry
  and writes only after a typed yes. Before a launch, `pluginLaunch`
  (`apps/runner/src/plugin-servers.ts`) recomputes the digest over the files it was given and
  canonicalizes the entry it was sent; with no record of that name, or a digest or entry other
  than the record's, it refuses before writing anything, so a label from the server proves
  nothing. It then writes the files read-only outside every root and the machine's config,
  runs a `./` command only when its real path is a file inside the plugin, keeps `cwd` inside the
  plugin or its data folder, and expands only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, once, in
  `args`, `env` values and `cwd`. The record proves the plugin's files and its command line, not
  what that command downloads when it runs (`npx some-package`): `allow-plugin` says so whenever
  the command isn't a file of the plugin, and so does the tool's page. Dispand delivers such a
  server as a runner tool (protocol 30): a `plugin` reference (tool id, plugin name, digest,
  entry) in a session start, `tool.discover` or a poll's `tool.call`. The runner checks the
  reference against its record first, then launches the folder it already wrote for that digest
  (named by the digest it computed over what it wrote) or fetches the files
  (`GET /runner/plugins/<tool id>`, its own token, a plugin runner tool on that runner only, no
  redirect, 16 MiB) and recomputes their digest. A session's CLI starts it behind the runner's
  MCP proxy, as any runner tool; a poll calls only what its server marks read-only, and paths in
  a poll's arguments are resolved from the plugin's working directory for the runner's guard.
- **Workspace plugin imports bring files, never code that runs.** Marketplaces and plugins are fetched with
  `fetchGit` (`packages/domain/src/plugins/git.ts`): `https://` only (no credentials in the URL;
  `file://` only in a development build with `DISPAND_GIT_FILE_URLS=1`, for e2e fixtures),
  redirects not followed, no prompts, hooks, submodules, LFS or system and user git config,
  60 s and 200 MiB on disk at most (a limit kills git's whole process group), into a temp folder removed afterwards. A plugin in the
  Agent Plugins layout (a root `plugin.json`) is read with that standard's rules. A schema-less root object may use the Claude loader when a named Claude manifest exists; explicit schemas never fall back. Both loaders run under the same
  limits: its `$schema` ids are known, never fetched; a linked `plugin.json` rejects it; its
  stdio servers are read (a `./` command and `cwd` that stay inside the plugin, or a `cwd` in
  its data folder). Dispand runs none of a plugin's commands itself; it keeps a standard plugin's
  files when it has a stdio server (`plugin_files`, at most 500 files and 11 MiB, so their base64 fits the runner's 16 MiB response cap; a larger
  plugin installs keeping none, and its stdio servers can't be added; links, `.git` and paths a
  runner can't write left out and listed), and a runner runs such a
  server only as the paragraph above says. A plugin in the Claude layout keeps none: its stdio
  servers are added from a runner's own `mcpServers`, as today. Its `com.dispand`
  definitions (tables, agents, triggers) are data and grant nothing: install only stores them,
  each read as a regular file within the same budget and checked alone. What is made from one is
  made by the procedure a direct call uses, by the owner or through an approved proposal, with
  that procedure's checks. The owner's setup (`plugins.setUp`) makes the items a proposal would
  list, each through its procedure with the owner's own session, and binds to what an earlier
  setup made only by the id it recorded, never to a table by its name. An agent made from a
  definition is the plugin's element, made by `agents.create` with the bundles, tables and
  self-learning the owner reads in the item, so its consults pass the same pair check as any
  agent's. That a row is a plugin's is set only by the server (`context.pluginElement`, which no
  request input reaches); an update shows, before applying, every change that
  gives an agent more or moves a tool's calls, every change of what an agent is told, and every
  field of the owner's the plugin changed; it applies only what was shown (`reviewed`), through
  each element's own procedure, and never replaces an overridden field unasked. A tool it gives
  an existing agent starts with every action on Ask, whatever its server calls read-only. What a
  new version adds is made by no update: only by a setup, whose items show each grant. A plugin's HTTP server becomes a tool only through `plugins.addServer` (or its setup
  item), with no credentials and only at the URL and transport the owner reviewed in the item; a
  stdio server only as a runner tool on one of the owner's runners, with the digest the owner
  reviewed in the item, and it runs nothing until that machine's record allows it. Links are checked out
  as plain files (`core.symlinks=false`), then removed from the checkout and listed as not
  imported: nothing is ever written or read through one, and a file name that isn't UTF-8 refuses
  the fetch. Every file is read with `lstat`, any other non-regular file is skipped, and a plugin or skill folder whose real path leaves the
  repository is refused. An install imports only the components the owner ticks: skills, each
  through `validatePackage` (so `isSafeRelativePath`); agents, as a system prompt on the harness
  the owner picks (the agent file's `tools` and `model` are ignored); and HTTP MCP servers, as
  HTTP tools. An imported agent or tool is the plugin's element: an owner's change of one of its
  fields is an override made by the element's own procedure, with its checks, and an update of
  the plugin never replaces an overridden field. A reset to the plugin's value goes through that
  same procedure, so a tool sent to another origin, by an override or by a reset, loses its saved
  headers and sign-in. An uninstall applies only what its preview showed (`reviewed`) and the
  choices the owner made, checked as a whole on the server: nothing a kept element uses is
  removed without a stated choice, and both procedures need an owner session. A file of a
  plugin's skill the owner writes goes through `validatePackage`
  with the whole package, as an upload does: no path leaves the package, and the caps hold. A server is unticked until the owner ticks it with its URL shown, and is imported
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
  plugin's foreign keys never cascade into the owner's data. The owner's explicit removal
  checklist can delete only packages, tools and agents currently owned by that plugin. Selected
  skills and tools are unlinked from kept agents and skill requirements; workflow tool references
  still block deletion. Assistant and workflow agent guards remain enforced, and selected agents
  go through `Engine.deleteAgents` so their Jobs and history remain. Unticked components are
  detached and kept. Native removals use the runner's reviewed, account-scoped lifecycle before
  workspace removal; partial native success is shown and never retried automatically. Generated
  plugins do not own their listed business data, which removal keeps. Older calls without a
  checklist keep agents/tools and delete only unused packages. No foreign key to `plugins` cascades to
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
- **A Web Push carries an agent's name, the item's kind and its random id, nothing else.** What
  agents wait on reaches the browsers the owner allowed (`push_subscriptions`, from the Inbox) through
  the browser vendor's push service: the payload is exactly `{ text, count, itemId }`, `text` a
  sentence naming the agent and the kind ("Drafting needs your decision."), `itemId` the newest
  item's opaque id, never a question's text, an answer or a proposal's items. We decided an agent's
  name, which the owner may make business-specific, may pass through that service. The payload is
  encrypted to the browser's keys (RFC 8291) and signed with the install's VAPID key, generated
  once and sealed like the other secrets; a subscription's keys are sealed too, and `push.list`
  returns neither them nor its endpoint. The server posts only to an `https://` endpoint the
  signed-in owner subscribed, in production never to its own addresses (the tools' guarded
  fetch), reads only the answer's status and gives up after 15 seconds. Signing out deletes that browser's subscription (`push.unsubscribe` needs only a session, never a workspace, and deletes only the person's own rows), and one the push
  service answers 404 or 410 for is deleted. The page's only worker is its own service worker
  (`worker-src 'self'`, `/sw.js`), which shows every push and opens `/inbox?item=<id>` on a
  click. The push procedures are no tool.
- **Every input is validated** by its procedure's Zod schema; errors don't leak internals:
  anything but an `ORPCError` reaches the page as the generic message (oRPC sends no text, the
  log only `logError`'s summary), and so does an `ORPCError` with no message key (the page shows
  only keyed messages and text marked external), and a server message's values render as text, never markup. Text from outside stored in a failure column goes through `plainText`, so one shaped like JSON can never read as a stored message.
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
  A harness's runner and base URL are its workspace managers' to set, whoever made it: every
  agent and workflow of the workspace that uses the harness sends its prompts and inputs there,
  the workflows of other members included. The base URL may be loopback or on the deployment's
  own network (a local model server is a supported provider), and model listing and model calls
  go there from the server. **Out of scope:** a manager reaching the server's network through a
  harness's base URL; a deployment that hosts people it doesn't trust with that blocks those
  addresses at its egress.
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
  them again for the new address. The cryptography holds it too: a header's AAD also names
  the origin of its tool's URL (`headerAad`), so a header left on a tool pointed at another
  origin doesn't open and is never sent there. Headers sealed before this binding are sealed
  again once, at server start, with the origin their tool calls then (`tools/reseal.ts`); MCP calls follow a redirect only
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
  input wires to it. A Tool step runs only the HTTP tools of its run's workspace (looked up by id and
  workspace at each call), and a call cut by a restart is never made again: its step fails.
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
the same owner and step, and every unanswered inherited call is marked interrupted instead
of executed. A revoked historical runner is refused before the Job becomes active. Failed
or stopped Jobs and workflow runs cannot be reopened.


A person may explicitly invoke an installed skill from the Assistant composer. Its owner-scoped
skill id is resolved server-side and extends only that conversation's snapshot (`invokedSkills`)
with the package and its required tools. Agent-originated RPC calls cannot make this choice.
This is an explicit exception to the ordinary snapshot/agent intersection: currently installed,
selected packages remain available to that conversation, without editing permanent agent
configuration. Required tool actions still use the existing approval broker; selection grants
no unasked actions. A runner serves selected files only for its owner's Assistant conversation
on that runner. Deleted packages cease to be readable through the server. Local discovery
paths never reach the browser; Codex skill inputs resolve paths only inside its runner.
