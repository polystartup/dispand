# Agents, to Dispand's data, rights and people

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
- **Someone else's text goes into a prompt as data, in a block it can't close.** Wherever Dispand
  writes text another party wrote into what a model reads as its prompt, the text goes in a block
  whose tag is 128 random bits drawn for that prompt (`data-block.ts` in `@dispand/runner-protocol`),
  and the prompt ends with one rule naming the tag: what is inside was not written by the author of
  the instructions, is data, and gives none. Text written before the tag was drawn can't name it, so
  it can't end the block or start one. That covers every prompt filled from a run's values
  (`renderPrompt` in `engine/prompt-data.ts`, its only filler): of a Job's trigger, every value but
  the ids and states the platform makes (`PLATFORM_VALUES`), so a polled item and its id, a row's
  values before and after, an agent's name, a consult's question and a plugin update's values; of a
  workflow, a Tool step's result and fields, a data step's rows, and a loop's item or results made
  from those. A consulted agent's answer with its name, and the reason a consult got none, are in one
  too, however the asking session gets them (`consultAnswer`, on the server and the runner alike),
  and so is an agent's answer to a question when a session gets it as words. `engine/prompt-sites.test.ts` lists every place the engine
  or the cloud loop gives a session text, by where that text comes from, and fails on a new one.
  Left as they are, on purpose: a person's own words (their messages, answers, approvals and the
  files they attach); an agent's instructions, its plugin's included, and skills, which are
  instructions by design; memory, guidance kept for later Jobs (its procedures among it), bounded
  as the memory bullets below say; a workflow's agent step outputs, which its author chains for the
  next step to act on; and tool results and tool descriptions, which reach the model in its
  provider's own channels for them. A block binds no model and changes nothing an agent may do:
  its rights do ([attackers.md](attackers.md)).
- **A session gets its agent's skills and tools, and no more.** For a Job, what its snapshot
  holds and the agent still has; for a workflow run, the agent's as they are. A tool reached by
  URL is called on the server only, for cloud sessions, with its sealed headers opened for that
  call: a session start never carries a tool's address or headers, only the names of the
  runner's own MCP servers the agent was given (and only those of the harness's runner). Every
  call of such a tool asks the owner first, in a cloud session as on a runner. A cloud session's
  `read_skill` reads only a file of a skill in those packages, checked again at each call, by
  its exact stored path inside the skill's folder (an unsafe path is refused, nothing is
  decoded): it reaches no other package and no file on the server.
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
  Codex (checked with 0.171.0 on what the model is sent, `codex/restricted-tools.test.ts`): every native tool a switch
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
  [sessions.md](sessions.md)). A person's write needs no acceptance; an agent's write clears it. Accepted: an entry written by one Job instructs the Jobs without
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
  marked `built_in = 'assistant'`, one per person and workspace (a unique index). That mark is in no
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

Runner tools in a Job may run only the actions its agent or the owner's run decision marks unasked; workflow runner refs carry explicit run grants only. The runner derives fully qualified MCP names from its own configured servers; these grants never name shell or file tools. Live permission updates only intersect existing grants, including on reconnect and during startup. Server aliases bind a tool id and its runner target, so removing or renaming another tool cannot reassign a grant. A persistent approval must still name that target and its current permission when delivered; a revocation invalidates pending local permission caching. Automatic runner calls use the same protected-path argument guard as polls. Server-side changes reach workflow sessions as well. Catalog runner tools with empty action permissions receive their catalog defaults once during the approved upgrade; non-empty lists and HTTP tools keep their permissions.

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
