# Platform tools, the Assistant, memory and the Inbox

- **Platform tools:** a Job's session gets some of Dispand's own procedures as tools.
  `platform/tools.ts` is the registry: each tool names its procedure (`rows.create` is the tool
  `rows_create`), its bundle (`data`: `tables.list`, `tables.get` and the rows procedures, with
  `tables.list` given to `configure` too, which needs table ids;
  `configure`: creating and renaming tables, creating, changing and ordering fields), what the
  agent reads about it, and how to find the tables a call touches from its input (a row or a
  field gives its table). Every other procedure is listed there as not a tool, and a test walks
  the router and fails on a procedure that is in neither list, so adding one never hands it to
  agents unnoticed. An agent has `bundles` and `dataTables` (all tables, or a list), copied into
  its Jobs' snapshot. `callPlatformTool` (`platform/call.ts`) is the one path a call takes: the
  Job must still be going, the tool's bundle and every table touched must be in the Job's
  snapshot and still on the agent (rights shrink with the agent at once and never grow after the
  Job was created, but for a table the Job creates: we decided it joins the agent's `dataTables`
  and the Job's snapshot tables, where each is a list, in `tables.create`'s own transaction
  (`joinCreatedTable` in `platform/rights.ts`, both rows locked `FOR UPDATE`, the plugin's agent
  marked overridden on `dataTables`; refused when the agent already has its 100 tables)), an id that names nothing is answered like a table out of scope ("Not
  found"), and the procedure then runs in process as the Job's owner (`InitialContext.job`,
  which only that function sets; the gates read it instead of a session). Refusals and
  procedure errors come back as words, any other failure as "The tool failed". Cloud sessions
  get these tools through `platformToolCaller` (`platform/cloud.ts`), the engine's `ToolCaller`
  in the app: the tools of the session's Job, with their JSON Schema, marked `ask: false`, so
  the cloud runner asks no permission question for them; a workflow run's session gets none.
  CLI sessions reach the same tools over MCP at the Job endpoint, `/mcp/job`
  (`platform/mcp.ts`, the route `routes/mcp/job.ts`): one endpoint for every Job, stateless,
  built with the MCP server SDK (`requireBearerAuth`, `createMcpHandler`, one
  `McpServer.registerTool` per tool the Job may use now, each calling `callPlatformTool`). The
  bearer is the Job's token (`platform/token.ts`): `dj_` and 32 random bytes, issued in
  `Engine.createJob`, stored as its SHA-256 (`runs.token_hash`, how a request finds its Job)
  and sealed (`runs.token_sealed`, opened by `CliHarnessAdapter.start` at each start, a resume
  included); a token names its Job only while the Job is running or waiting. The start carries
  it as `jobToken` (protocol 5) and no address: the runner adds the Job server to the
  session's MCP servers itself (`withJobServer` in `apps/runner/src/mcp.ts`: `/mcp/job` of its
  configured server, named `job`, a name starts can't use; a same-named server of the user's
  own CLI config is replaced for the session on Claude Code, and refuses the session on Codex,
  which would merge the two), and lets `mcp__job__*` tools run
  without a question; every other MCP tool asks as before. Both harnesses apply the one policy
  for a call to an MCP server's tool (`toolPolicy` in `apps/runner/src/tool-policy.ts`: disabled
  actions, protected arguments, unasked actions, bypass, the question and what its answer
  grants), Claude Code from `canUseTool` and the `PreToolUse` hook, Codex from its approval
  request. The agent's page
  sets the bundles and tables (`components/settings/JobRights.tsx`).
- **The Assistant:** the workspace's built-in agent, an `agents` row with `built_in =
  'assistant'` (migration 0048; a partial unique index keeps one per person and workspace,
  since migration 0132, so a person has their own in each workspace they open). No procedure's
  input carries `built_in`: `ensureAssistant` (`agents/builtin.ts`, behind the owner's
  `agents.ensureAssistant`, not a tool) makes it on the harness the owner picks, with `data`
  and `configure` on all tables, the `workspace` self-learning target, the platform skill and a
  chat trigger, and gives the one there is otherwise; it runs at server start for every Assistant, so what a version adds reaches
  existing ones. `assistantGuard` is the one check of what may change on it (its bundles, its
  tables, its platform skill, its chat): `agents.update`,
  `agents.delete`, `triggers.update`, `triggers.delete` and `createProposal` (for
  `agents_update`, `agents_delete` and `triggers_*` items, refused when proposed with the reason) call it. We
  decided its self-learning isn't one of those: the owner may untick `workspace` on its page.
  It keeps the business in the workspace's memory: the platform skill's day-one proposal ends
  with a `memory_add` of the business (`type: "business"`) in place of a change of its own
  instructions, and an install from before gets the target once (migration 0080, on Assistants
  whose `self_learning` was empty); a description already in its instructions stays there until
  the owner approves the move it proposes. Its
  Jobs' system prompt starts with a fixed text (`jobSystemPrompt`, `engine/job-def.ts`), then
  the owner's instructions. It stays `assistant` in code and data; what people see is the
  label `agent.assistant.name` of the `messages` files (`packages/domain/src/messages/`),
  "Stem" in English and in French, whatever its stored name (`shownAgentName` in the web, the
  chat's labels, and its page's Name field, read-only there so the stored name never changes).
  Its fixed text and the platform skill (`{{assistant}}`, filled as `skill.ts` bundles it) name
  it from the English value. The web's `/assistant` (`components/assistant/AssistantChat.tsx`)
  is its chat trigger's `ChatPanel` beside the list of its conversations (`runs.list` with
  `kind: "chat"`, newest first, titled by the first message; a plain list of Jobs, not
  assistant-ui's thread list), the open one held in the URL's `run` (absent: the latest;
  `new`: one that hasn't started), or first launch while there is no Assistant: the harness
  sheet when the owner has no harness, then a picker that calls `agents.ensureAssistant`.
  `onboarding.status` (the Assistant's id or null, and whether a harness exists) makes Home
  send an owner without an Assistant there, from its route's `beforeLoad` (`getFirstLaunch`):
  the redirect waits for neither Home's page nor its queries.
- **The enhancement review:** `ensureAssistant` also gives the Assistant a schedule trigger
  marked `built_in = 'review'` (migration 0054, one per agent), Mondays at 09:00, one at a
  time, made **off**; `assistantGuard` refuses only its deletion. The `/assistant` page's
  switch (`components/assistant/ReviewSwitch.tsx`) turns it on with the browser's time zone.
  Its Job calls `workspace_review` (`workspace.review`, a `configure` read), which runs
  `reviewSignals` (`assistant/review.ts`): a deterministic read of the rows, each signal with
  the ids it names and a key; a signal whose key an Approval of the Assistant's names and the
  owner denied in the last 30 days is left out, and a Job limited to some tables isn't told
  of the others. The model only proposes, one proposal per signal (the platform skill's
  `references/review.md`). A scheduled Job has no chat, so its questions are already
  `notifications`: its Approvals go to the Inbox with no change to `request_approval`.
- **The platform skill:** the skill package `dispand-platform` (`assistant/skill/`: its
  `SKILL.md` and references on Dispand's concepts, triggers and how to propose a setup), bundled
  into the build by Vite's `import.meta.glob` (`assistant/skill.ts`), so its files are the
  application's. `syncPlatformSkill` writes it as each owner's one built-in package
  (`skill_packages.built_in`, migration 0050, a partial unique index), replacing its files when
  they differ from the build's; it runs at server start for every owner
  (`syncPlatformSkills`) and in `ensureAssistant`, which attaches it to the Assistant. It
  reaches sessions like any skill package (a CLI start names it; a cloud session lists it and
  reads it with `read_skill`). Any agent may be given it: it describes, it grants nothing.
- **Skills and tools in sessions:** `engine/tooling.ts` says what a session's agent gives it
  (`sessionTooling`, from the session's step: the Job's agent, or the workflow node's): the
  agent's skill packages and effective tools as they are now, kept, for a Job, to those of its
  snapshot. A CLI start carries the skills (the runner fetches each package from
  `/runner/packages/<id>`, which serves a package only to the runner of a harness whose agent
  has it) and one `runner` MCP server per runner tool of the harness's own runner, named by
  `serverName` (lowercase words joined by `_`, never `job` or `dispand`, distinct; the CLI starts
  each behind the runner's MCP proxy, `apps/runner/src/mcp-proxy.ts`, see Attachments); they are
  read at each start, so a resume carries them as they are then, and are never stored with the
  step. A CLI session gets at most 50 skill packages and 20 runner tools (`MAX_SESSION_SKILLS`,
  `MAX_SESSION_RUNNER_TOOLS`), the first in name order; saving or reading an agent on a CLI
  harness past either returns `leftOut` (per kind, the limit and the names past it), and the
  agent page warns with it in a whole sentence. HTTP tools never travel. A cloud session gets them through `installedToolCaller`
  (`tools/cloud.ts`): one tool per action, called on the server through `InstalledTools`, asked
  before each call like any tool that isn't Dispand's own, and checked again at call time
  (a tool taken back, or an action gone, isn't called). `createEngine` combines that caller
  with the app's (`combineToolCallers`). A Job's CLI session gets its agent's HTTP tools from
  the tools endpoint, `/mcp/job/tools` (`platform/tools-mcp.ts`, the route
  `routes/mcp/job_.tools.ts`): same bearer as the Job endpoint, one tool per action, called through `InstalledTools`. An action's name
  (`exposedName`) is readable words plus a mark made of the tool's id and the action's name
  alone, so it stands for that tool and action for good and an approval can't come to mean
  another (`platform/exposed.ts`; when such a call is asked about, the engine records on the
  question which tool and action it is, `questions.about`, shown in the Inbox and in a chat);
  the endpoint uses the SDK's low-level `Server`, so a tool's JSON Schema is shown as
  it is and never compiled on the server. The runner adds it as the server
  `job_tools` next to `job` (`withJobServer`), and its tools ask like any MCP tool. A call runs
  only if `takeApproval` (`platform/approvals.ts`) finds and uses up an approval: a question of
  the Job's run, still going, of kind `approval`, answered with an allowance, not yet consumed
  (`questions.consumed_at`), for the tool name the CLI asked about
  (`mcp__job_tools__<name>`) and canonically equal arguments. What may be called is read again
  at call time, before an approval is used. An action in the agent's `agent_tools.unasked`
  for that tool needs no approval, there and in a cloud session (`ask: false` on its spec):
  the list is filled from the actions' `readOnly` (the server's `readOnlyHint`, kept at
  listing), or for a catalog tool from its entry's `unasked` alone (`defaultUnasked`), when `agents.create` or `agents.update` adds the tool, kept as it is for a tool
  the agent already had, and changed by `agents.setToolPermission` only (`agents.toolAsk` reads it;
  changing permissions is a proposal-only platform grant). For a tool the agent has only through
  its skill packages, a future-run answer goes to `agent_skill_tool_permissions` (migration
  0078; `writePermission` in `agents/tool-ask.ts`), read by `toolingOf` where the agent has no
  `agent_tools` row, and only for the tool's current `toolPermissionTarget`. With the workspace's
  strict permissions on (`workspace.setStrictPermissions`, migration 0081), each of those lists
  holds only while its `strict_target` (the target with the tool's listed actions and schemas, its
  plugin's commit, the package's `fingerprint` and the agent's `revision`) still matches
  (`heldUnasked`, used by `toolingOf`, `writePermission` and `agents.toolAsk`). A Job's session start names those actions (`unasked`, their
  exposed names, at most 500; protocol 7), and the runner lets `mcp__job_tools__<name>` run
  without a question for them (the Claude permission hook or Codex elicitation): the CLI
  prompts for the others. A scoped owner answer carries `remember` (protocol 20), after the
  engine validates the offer and writes its decision. An allow adds that exact MCP action to
  the session's cache; a deny blocks it. The engine marks remembered allows consumed so a later
  revocation cannot revive a leftover approval. Workflow runs' CLI sessions have no Job token, so
  no such tools.
- **Memory** (`memory/`): the workspace, each Data table and each agent have a memory, one
  `memories` row per entry (scope, its table or agent, `path`, `name`, a one-line
  `description`, a `type` among `business`, `practice`, `fact`, `reference`, `body`, the
  `author` of its current revision, `accepted_at`, `removed_at`) and every revision, a removal
  included, in the append-only `memory_revisions`. A table's or an agent's memory goes with it.
  `memory/store.ts` is the one writer: an entry is checked by `MemoryEntryInput`
  (`memory/model.ts`, which holds the caps: 100 live entries per scope), its path by
  `isMemoryPath` (runner protocol: a safe relative `.md` path of at most 120 characters, never
  `CLAUDE.md`, `AGENTS.md`, `AGENTS.override.md` nor `MEMORY.md`), and writes to one scope are
  serialized by a transaction lock. The index (`memoryIndex`) is never stored: it is made from
  the entries, grouped by type. A person's write makes the person the author; an agent's clears
  the acceptance a person gave (`memories.accept`). Revert brings back the previous revision,
  author included, and restore a removed entry as it last was. The owner's procedures
  (`memories.*`, not tools) back the workspace memory page under Settings (`MemoryPanel`).
  Every write is a `memory.write` span and `dispand.memory.writes` (scope, operation, result),
  never a path or a body, and a `memory.written` Audit row in the write's transaction (by the
  person or the Job, on the entry, with `scope`, the table or agent, and `operation`: `add`,
  `update`, `remove`, `accept`, `revert` or `restore`; a person's write included, a refused one
  none).
  An agent's self-learning switch (`agents.self_learning`: targets among `agent`, `data`,
  `workspace`, empty by default) says where its Jobs may write memory. Setting it is part of
  `agents.create` and `agents.update`, grants a Job reaches only through an approved proposal;
  the Job's snapshot keeps the targets and `rightsOf` gives those the agent still has.
  A Job's memory tools (`memory/tools.ts`, `MEMORY_TOOLS` in `platform/tools.ts`) are, like the
  inbox ones, run by `callPlatformTool` through their `run`, which gets the Job's rights. They
  have no bundle: their own `available` rule gives them (`allowed`), `memory_read` to every Job
  and the three writes to a Job whose rights hold a target. A table scope's table goes through
  the call's table check like any other; the rest of the rule (which target, `data` for a table,
  `configure` to read another agent's memory) is `memory/tools.ts`'s. A write is authored by
  the Job (`{ agentId, runId, configure }`); a write refused for its target is a `memory.write`
  span and counted like the store's own refusals, and a read is a `memory.read` span and
  `dispand.memory.reads` (scope, result).
  `artifact_show` (`artifacts/show.ts`, `ARTIFACT_SHOW` in `platform/tools.ts`) is every Job's,
  in the same way: it stores generated HTML or SVG in `artifacts` (cascading with the run) and,
  in one transaction, a tool message whose `result` is a reference
  (`{ kind: "artifact", artifactId, title, format, size }`), published to the open chat through
  `engine.settled`, for cloud and CLI Jobs alike. Snapshots and events carry the reference only;
  `artifacts.get` checks access to the parent Job before returning the code. Its Audit row and its `artifacts.show` span
  hold ids, the format and the size in bytes, never the code or the title.
  The chat shows the reference as a card (`components/chat/ArtifactPart.tsx`, the `artifact_show`
  tool of the thread's toolkit, so history replays it without running a tool). Run, after a
  warning, fetches the code and renders it with Generative Frame (`generative-frame/react`,
  opaque-origin `srcdoc` frame, no CDN, height up to 480 px); see `SECURITY.md`. A running
  artifact has Expand: a dialog (so Esc, the focus trap and the focus's return to Expand are
  Radix's) with a new frame filling the window's height, the inline one unmounted, so the
  artifact's scripts start over. The frame is given the app's theme (`styles/tokens.css`, read by
  `useThemeTokens`) and told of each light or dark change. Esc doesn't reach a frame that holds
  the focus: the dialog has a Collapse button.
  Every start the engine sends for a Job (`launch`: the first, one sent again after its runner was
  away or its slot came, a resume) reads its memory again (`memory/read.ts`), and the stored
  start never holds it; a resumed cloud session keeps the new system prompt for its next calls.
  `memoryForJob` takes the workspace's, the agent's and, with `data`, every table within the
  Job's tables now (a primitive trigger's table first, the others by name), and for a Job with
  `configure` leaves out, and counts, the entries a Job without it wrote and no person accepted.
  `fitMemory` is the one fill rule of its renderings: every scope's whole index first (a table
  whose index no longer fits is left out whole), then entries in order until one doesn't fit,
  within the rendering's budget, measured on what is sent, the closing line ("More memory, with
  memory_read: …") included. The system prompt gets `memoryPrompt` (96,000 characters at most)
  after the agent's instructions; nothing is snapshotted, and workflow agent steps get none. The
  read is a `memory.prompt` span (counts only) and `dispand.memory.prompts` (none, whole, cut).
  On a runner the same reading also goes as files (`StartFields.memory`, protocol 13): the
  engine hands it to `CliHarnessAdapter.start`, which serializes the start without it and fills
  `memoryFiles` within what that leaves of the 1 MiB frame less 32 KiB, measured in UTF-8 bytes
  of each file's JSON (each scope's `MEMORY.md`, then entry files with their frontmatter; the
  closing line in the workspace's `MEMORY.md`), a `memory.files` span and
  `dispand.memory.files` (none, whole, cut). The runner writes them under the run folder's
  `.dispand/memory/<workspace|agent|tables/<id>>/` (`apps/runner/src/memory.ts`), emptied at
  each start and removed when the session ends, and the runner prompt's block says where they
  are.
- **Skills in cloud sessions** (`skills/cloud.ts`): the way Agent Skills work. At every model
  call `sessionSkills` reads the skills of the session's packages (`sessionTooling`: for a Job,
  its snapshot's that the agent still has); the system prompt lists each skill's name and
  description (`<package>:<name>` when two packages share a name), and the built-in
  `read_skill` (`cloud/builtins.ts`, a name `tool-names.ts` reserves; offered only when there
  are skills) reads one file of one of them, `SKILL.md` first, without asking the owner. A call
  reads the skills again, refuses a path `isSafeRelativePath` refuses (`..`, `.`, absolute,
  backslash), and looks the file up by its exact stored path `<skill>/<path>` in that package:
  nothing is decoded or normalized and no filesystem is involved, so an encoded path names no
  file. A missing file's answer lists the skill's files; a file that isn't UTF-8 text is
  refused; a longer one than a tool result may hold is cut. Each read makes a `skill.read` span
  and counts in `dispand.skill.reads` (how it ended only).
- **What polls may read** (`tools/pollable.ts`): `tools.pollable` (the owner's list, migration
  0042; null: the actions the server marks read-only) says which of a tool's actions a poll may
  call, and `isPollable` adds that no agent holding the tool must ask before using it (the
  action is in every holder's `agent_tools.unasked`; an agent that has the tool only through a
  skill's required tools asks before every action, unless a future-run answer was kept for it
  in `agent_skill_tool_permissions`, which polls don't read). `tools.pollable` and `tools.setPollable`
  are the owner's (never platform tools); the tool sheets show each action's state and why one
  isn't polled. Polls check `isPollable` when a trigger is made and at every dispatch.
- **Proposals** (`platform/proposals.ts`, table `proposals`, migration 0034). Agent items save
  `toolPermissions` beside their parsed input: explicit overrides, retained permissions on
  updates, or defaults computed when prepared. `itemsView` exposes these as `tools[].runs`;
  `takeItem` returns the saved permissions for the procedure, without re-reading defaults.
  Each permission carries a target binding, checked under the agent write's tool-row lock;
  `tools.permission_revision` (migration 0064) increments on each retarget, so pointing a tool
  back does not make an old approval valid again.
  Plugin setup uses the same preparation and execution, with a preview digest checked before
  writing. Old pending agent grants lacking a permissions snapshot must be proposed again.
  A tool of the
  registry marked `grant` (`agents.create`, `agents.update`, `agents.setToolPermission`,
  `agents.delete`, `tables.delete`, `fields.delete`, `fields.retype`, `triggers.create`, `triggers.update`, `triggers.delete`, `tools.add` (an address and no
  headers; `tools.create` stays the owner's) and `tools.delete`;
  a tool's name is its path in lower case with `_`) is refused by `callPlatformTool`
  unless `takeItem` uses up a matching item of an approved proposal of the Job: one
  transaction that locks the Job's approved proposals and marks the first unused item with
  that tool and canonically equal input (`canonical`, `platform/approvals.ts`). Without an
  item, a grant still runs when its `direct` check passes: `triggers.update` has one
  (`ownTriggerOff`: the parsed input is `id` and `enabled: false` alone, on a trigger of the
  owner's whose agent is the Job's), and `fields.retype` another (`dryRun: true`, which only
  counts; its `shown` refuses proposing a dry run). `agents.delete`'s `shown` refuses the Job's
  own agent, whose deletion would stop the Job in the middle of its call; the Inbox marks the
  items that can't be undone (deleting a table, a field, a tool or an agent, and changing a
  field's type). `propose`, a
  tool with no router path (`PROPOSE`, handled in `callPlatformTool`), stores a draft through
  `createProposal`: configuration writes of the Job's bundles only (`grant` tools, and the
  others marked `write`: `tables.create`, `tables.rename`, `tables.setPrimitive`,
  `fields.create`, `fields.update`, `fields.reorder`, and the memory writes `memory_add` and
  `memory_update`, refused when proposed outside the Job's self-learning targets through their
  `shown`), inputs parsed by the tool's schema
  and stored as parsed, storable text, at most 60 items and 64 KiB. An input may hold
  `{ "$item": n }` where an id goes, `n` an earlier item whose tool creates something
  (`CREATES`: `tables_create`, `fields_create`, `agents_create`, `triggers_create`,
  `tools_add`); it is parsed with a random placeholder id in its place (also checked against
  the Job's tables, so a Job limited to some tables can't name a table it creates) and stored
  as the reference. A `write` call matching an unused item uses it too (a tool with a `run`,
  such as `memory_add`, takes it before it runs), and a call made as an
  item is `pending` from when it is taken until its call ends, then records on it the id its
  output carries (`createdId`) or, when the procedure refused it, `failed`; `takeItem` compares a call with an item's input whose references are replaced
  by those `createdId`s (an item naming one with none can't match). `proposal_apply`
  (`APPLY`, also handled in `callPlatformTool`) checks the proposal is the Job's and approved,
  then calls `callPlatformTool` for each unused item in order with that item's position (`at`:
  only that item may be taken, and a call that can't take it is refused), stops at the first
  refusal or at a `pending` item (another call is making it), and
  returns each item's outcome; no transaction spans items (some reach the
  network), so a later call goes on from the first unused one. It is traced
  (`platform.proposal_apply`), counted (`dispand.proposals.applied`) and logged when it stops. `request_approval` takes
  an optional `proposal` id (cloud: `approvalMessage`; runner: `requestApproval`, protocol 8,
  so a runner that would drop the argument is told to update), kept in the question's input. When the engine records such a question it calls `attachProposal` (draft
  to `asked`, with the question's id; `questions.proposal_id`, migration 0035), and
  `Engine.answer` calls `settleProposal` in the answer's transaction (`approved` on a
  person's yes, `declined` on a no). `questions.list` adds `proposal` (`proposalView`: the
  items, each with `refs`, the keys of its input that hold ids according to `REFS`, what it
  `creates`, its `createdId` and whether it `failed`, and the names of those ids, a
  table-change trigger's table and fields and what used items created included); the web shows
  it with `ProposalItems`, which reads such a trigger's config in words (`ChangeConfig`) and a
  reference as what the item it names creates. `propose` may name a business (`plugin`, kept
  on the proposal, migration 0053): each time an item's call records a `createdId`
  (through `proposal_apply` or a direct call), `recordInPlugin` adds every `createdId` of the
  proposal's items, by kind, to the plugin
  "Generated: <business>" (`plugins.source = 'generated'`, `created`; no marketplace, URL or
  commit), creating it on first use (one per name in the workspace, `plugins_workspace_generated_idx`). It lists and
  owns nothing: `agents.plugin_id` and `tools.plugin_id` stay unset, and
  `plugins.uninstall` of a generated plugin deletes its row only; `plugins.update` refuses it;
  `plugins.list` names what it lists as it is now, leaving out what was deleted since.
- **Inbox:** every question a session asks is a row of `questions` with a `kind`: a permission
  is an `approval`, a choice or a confirmation a `question` (set when it is asked; migration
  `0030` moved the existing ones). An answer records who gave it (`answered_by`: a user, or an
  agent with its Job and the agent's name then) and when. `questions.list` takes `status: "pending"` (what waits) or `"all"`: what
  waits, newest first, then the 100 latest done items (answered or expired), each with its
  workflow or its agent and trigger, its answer and its answerer. The page is `/inbox`
  (`routes/_app.inbox.tsx`, `components/questions/InboxItem.tsx`): "Waiting for you", where
  each item is answered in place, then "Done"; `/notifications` redirects there, and the bell
  counts what waits. Nothing answers on the platform's behalf. An agent asks for an approval
  in its own words with the tool `request_approval({ message })` (1 to 4000 characters): the
  call is a permission question whose tool is `request_approval` and whose input is the
  message, so it is an Approval like any other, answered "Approved." or with the denial and
  the owner's reason. A cloud session has it as a built-in next to `ask_user`
  (`cloud/builtins.ts`); on a runner it is a tool of the runner's own `dispand` server (Claude
  Code) or a dynamic tool (Codex), which asks the owner itself (`requestApproval` in
  `apps/runner/src/outcome.ts`) in every permission mode, bypass included, and is never
  allowed for the session. The call waits for the answer however long it takes: Codex puts no
  timeout on a dynamic tool, and the `dispand` server's tools have Claude Code's longest one
  (`DISPAND_TOOL_TIMEOUT_MS`, about 24 days) instead of its default of about 28 hours or a
  lower `MCP_TOOL_TIMEOUT` from the user's environment (checked on Claude Code 2.1.311 and
  Codex 0.167). We decided a subagent asks the agent that started it, which decides
  whether to ask the person: on Codex, a `request_approval` call from a subagent's thread asks
  nobody and fails with a text telling it to return its question to that agent. On Claude Code, the other tool calls of a turn that asks for an
  approval wait for the answer (from the moment the CLI is about to call the tool), and aren't
  run after a "no"; a cloud session refuses them the same way.
- **Push notifications:** what agents wait on (new pending Inbox items: Questions and Approvals,
  never consults) reaches every browser or device the owner allowed, even with no Dispand tab open,
  through Web Push and the `web-push` library (`packages/domain/src/push/`). The VAPID key pair is
  made on first need and kept in `push_keys`, the private key sealed (`push/keys.ts`). The Inbox's
  opt-in registers the service worker (`apps/web/public/sw.js`), subscribes the browser and calls
  `push.subscribe` with its endpoint, keys (sealed, bound to the endpoint), a label from its user
  agent and the language it shows; subscribing again refreshes those, not its `created_at`.
  `push.list` gives the public key and the owner's devices; signing out calls `push.unsubscribe`
  and drops the browser's subscription. `PushSender` (`push/sender.ts`, started in
  `apps/web/src/server/app.ts`) is woken by `engine.questionChanges` and once at start, and sends,
  10 seconds after the first wake (what comes within the window goes together), every pending item
  to every subscription made before it was asked with no `push_deliveries` row for it: one push per
  subscription, `{ text, count, itemId }`, `itemId` the newest item, `text` rendered on the server
  from the domain messages (`push.question`, `push.approval`, plural by `count`) in the user's
  Settings language, else the subscription's. A success records a row per item, so a delivered
  item is never pushed again and a restart inside the window loses nothing; a failure is tried
  again a minute later, then twice as late each time up to an hour (only that device: the others
  have their rows); a 404 or 410 deletes the
  subscription. Pushes go through `pushVia(fetch)`: `web-push` encrypts and signs, the tools'
  address-guarded fetch posts (production), within 15 seconds. The service worker shows every push
  under the tag `dispand-inbox` (Safari revokes a subscription whose push shows nothing, so a
  focused window gets it too), and a click opens `/inbox?item=<id>`, which scrolls to that item. An
  open tab's own notification says the same sentence, only while its browser has no push
  subscription, so an item alerts once. Telemetry:
  a `push.flush` span, a `push.send` span per device, `dispand.push.sent` by `dispand.result`
  (`sent`, `gone`, `failed`), never the payload.
- **Stopping a run:** `runs.stop` (`Engine.stopRun`) fails every step of the run still open
  with "Stopped" (a step that never started too), expires its pending questions and fails the
  run, in one transaction, then cuts what the run was doing: a Tool step's call under way is
  aborted (each call has its own signal), and each session's harness is told to end it
  (`HarnessAdapter.stop`). A CLI session gets `session.stop` (protocol 4; the runner stops its
  CLI and says nothing for a session it doesn't run); a cloud session is marked done and its
  tool call under way aborted, and a call being prepared re-reads the session under its lock
  before it runs. Events a stopped session still sends find their step closed and change
  nothing, and a session being resumed re-reads its step right before its start is sent, so a
  stopped run never starts again. A stop that didn't reach its runner is sent when the runner
  comes back: `reconcile` ends every session the runner still runs that no step still going is
  waiting on, whether its rows are still there or went with a deleted workflow or agent. The run page
  has the Stop button (`components/runs/StopRun.tsx`), behind a confirmation.
- **Home and widgets:** `pages.home` returns the owner's home page in the workspace with its widgets, creating
  it on the first call (a partial unique index keeps one per owner and workspace; every page has a `workspace_id`, and a widget only shows a table of its page's workspace); it can't be renamed or deleted and is listed first. Other pages (`kind: "page"`, `pages.create`, `rename`, `delete`; at most 50 per owner and workspace, titles 1-100 characters, duplicates allowed) are listed under Home in the sidebar and shown at `/p/<id>` by the same `PageView`; deleting one deletes its widgets (cascade). A
  widget is a workflow form (`type: "workflow-form"`) with a layout per breakpoint (`lg`, `md`,
  `sm`: grid and columns in `packages/domain/src/pages/layout.ts`, shared with the web
  dashboard, which uses react-grid-layout). A Chat field's widget follows the latest run of its
  workflow through `runs.stream` and shows the chat's questions inline; they are counted in
  the Inbox too, and answering in either place updates both. Widgets showing one run share
  its watch (`apps/web/src/lib/run-watch.ts`); at most 3 run streams are open at once and other
  runs are polled. An interrupted watch keeps its last snapshot. The chat shows a reconnecting
  notice until a stream event or successful poll arrives. A quiet open stream leaves the notice hidden.
  The cap is per tab: the reverse proxy serves HTTP/2 (`deploy/README.md`), so several tabs
  don't exhaust the browser's connections.
  Grid and Table widgets (`type: "grid" | "table"`, `table_id` and a `config` of 1-20 field ids, plus a cover
  for a Grid and a default sort for a Table; a database check keeps each type's columns exactly)
  show a table's rows read-only: cards (100 at most, "Open in Data") or a table (50 at a time,
  "Load more"; header clicks sort for the viewer only; a row click opens `/settings/data/<table>?row=<id>`). `widgets.create` and `update` check the fields (and that the cover is a files field and the
  sort field sortable) against the owner's table; a field deleted since is skipped, a deleted table takes
  its widgets with it (cascade). The widgets and the Data grid refresh from `rows.stream` through one
  `useTableWatch` per tab (`apps/web/src/lib/table-watch.ts`): one stream over the union of the watched tables (20
  at most, the others polled every 10 s), re-opened 300 ms after the set changes, reconnecting with
  backoff and reading everything again after a drop; events are debounced 300 ms. The Data grid
  doesn't refresh while a cell is active, so rows don't move under the cursor; it reads what came
  once the cell is left.
