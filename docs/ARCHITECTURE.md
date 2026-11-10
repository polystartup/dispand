# Architecture of dispand

- **Apps and packages:** pnpm monorepo. `apps/web` (`@dispand/web`): TanStack Start app,
  UI and server. `packages/domain` (`@dispand/domain`): database, entity schemas and
  procedures. `packages/runner-protocol` (`@dispand/runner-protocol`): Zod schemas of the
  messages between the server and runners. `apps/runner` (`@dispand/runner`): the runner
  installed on agent machines (`apps/runner/README.md`).
- **API:** oRPC 1.x procedures in `packages/domain/src/rpc`, mounted at `/api/rpc` by a
  TanStack Start server route. The UI only goes through them, so a REST/OpenAPI and MCP surface
  can later export the same contract. Procedures use `authed` (session required) unless public
  on purpose (`auth.status`, `auth.setup`).
- **Runners:** `runners.create` (owner) makes a runner and a single-use pairing code (8
  characters, 15 minutes); the runner trades it at `POST /runner/pair` (public) for a token
  (32 random bytes, stored as SHA-256). It then dials `/runner/ws` with
  `Authorization: Bearer <token>` and `Dispand-Protocol: 4` (`PROTOCOL_VERSION`, bumped by
  every change an older runner can't parse or honor). An older runner is refused with 426 "update
  the runner" and its version recorded (`runners.protocol_version`; runners seen before protocol 2
  were set to 1 by migration 0009), so `runners.list` reports it `outdated` with the command that
  updates it in place (`install.sh --update`); any other version gets 400. `RunnerHub`
  (`packages/domain/src/runners/hub.ts`, one per process through `getHub`) hands each event to
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
  closes its socket; it is refused while a harness uses the runner. `hub.request` sends
  a `tool.discover` and waits for the `tool.discovered` with its `requestId` from that same runner
  (not numbered, not acked; "runner offline" or "timed out" after 45 s otherwise).
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
- **Harnesses:** a harness is `cli` (Claude Code on a runner, with a permission mode) or `cloud`
  (`anthropic`, `openai` or `openai-compatible`: base URL, model, system prompt, max tokens,
  effort, temperature for `openai-compatible` only), in `harnesses` with `type`
  (`packages/domain/src/harnesses`). A cloud harness's API key is sealed in `api_key_sealed`
  (AAD `apiKeyAad(id)`); views carry only `apiKeySet`, an omitted key on update keeps it and
  `""` clears it (only `openai-compatible` may have none). A key goes only to an `https://`
  base URL, or plain http to loopback. `loadCloudHarness` (server-only) opens it for the model
  clients (`cloud/model-client.ts`). `harnesses.models` lists a provider's models
  (`cloud/models.ts`: no redirects, 10 s, errors are "The provider refused the key" or
  "Couldn't reach <host>", never the provider's body).
- **Cloud sessions:** a step whose agent uses a cloud harness runs in process, in `CloudRunner`
  (`packages/domain/src/cloud/runner.ts`), which Dispand's engine drives like a runner:
  `RoutingAdapter` hands cloud sessions to it and CLI ones to the hub, and it reports the same
  `HarnessEvent`s, with `runnerId` `cloud` (`CLOUD_SOURCE`). Dispand runs the tool loop: the
  model gets the built-in `ask_user` (Claude Code's `AskUserQuestion` shape, a `choice`
  question) and `submit_outputs` (`builtins.ts`, the runner's rules and texts: `confirm-outputs`
  in a chat, one reminder elsewhere), and the agent's tools through a `ToolCaller` (none until
  agents get tools); every other tool call asks a `permission` question, and "Always allow"
  holds for that tool in that session only. Tool calls of a turn run one after another, and a
  turn makes at most 50 model calls. Each session is a `cloud_sessions` row: its history
  (append-only, the provider's raw assistant content replayed), what it waits on, the tool call
  in flight, its event seq and last event. Every state change is written with the seq of the
  event it causes before that event goes to the engine, one at a time, so on boot
  (`Engine.recover`, then `reconcile("cloud", …)`) only the last event is handed over again, and
  the engine drops it by seq; a tool call cut by the restart is answered "it may or may not have
  run" instead of being run again, and a model call cut by it is made again (its streamed text
  may show twice). Out of scope for now: an event the engine fails to store is logged and not
  retried (only the last one is replayed on boot), and a provider answer holding U+0000, which
  JSONB can't store, ends the session with an internal error. The harness and its key are loaded at each model call, the agent's model
  overriding the harness's; a provider error ends the step with a short reason
  (`providerError`), never the provider's body.
- **Workflows and the engine:** a workflow (`packages/domain/src/workflows`) is a manual
  trigger (Button or Chat) or a schedule trigger (a 5-field cron read in an IANA timezone,
  Europe/Paris by default, that gives `scheduled_for`; `schedule.ts` checks it, finds its fires
  with `cron-parser`, a 02:30 that a DST change skips or repeats firing at most once that day,
  and maps it to the editor's presets) and steps (agent, condition, data) joined by edges; edges out of a condition carry
  its `branch` (`then` or `else`) and it gives `matched`, from `evaluateCondition` (`condition.ts`) on an
  upstream value; each save that changes it is a new
  row of `workflow_versions`, and a run keeps the version it started on. Prompts reference
  upstream outputs as `{{key.field}}` (`template.ts`); an agent-driven node's expected outputs are derived
  from those references and the values conditions compare (`derive.ts`; other nodes give a fixed list, `sourceFields`), and `validateWorkflow` refuses unknown or non-upstream
  references and cycles before a run starts. A for-each loop step (`loop.ts`) runs its body, the
  steps whose `loopId` is its id, once per item of a list from upstream (`parseList`: a JSON array
  only; a list wired to an agent asks it for one), one iteration after another, at most
  `maxIterations` (1-100, default 20) times; loops don't nest, and no link crosses a loop's edge
  (a body's entry steps have no incoming link). A body step waits for its loop, so it may read
  what the loop's upstream gives, and from its loop `item`, `index` (from 1) and an object item's
  fields (`itemValues`); after the loop, steps read only its `count` and `results` (one object per
  iteration, its body steps' outputs by key), never a body step. A data step (`data-steps.ts`) creates a row, updates one or finds rows of
  one table; each input (one per selected field, files excluded), update-row's row id and each
  filter's value is a `Source`: a literal, or a `Ref` to an upstream node's output by node id (so renaming keeps it). A new
  input is wired to the nearest chat or agent step upstream (`setDataFields`), whose expected
  outputs then carry it with the field's name, table and type as description. A data step gives
  a fixed list (`DATA_OUTPUTS`): `row_id` (create and update); `count`, `row_id` (the
  first match, `""` if none) and `rows` (JSON, one object per row: `id` and each field's name
  and value as text) for find-rows. `validateDataSteps` checks them against the tables as they
  are (table and fields still there, no file field, literals that fit, filter ops of the
  field's type); `workflows.update` refuses a table that isn't the owner's, `runs.start` a step
  `validateDataSteps` flags, and `tables.delete` (`CONFLICT`) a table a workflow's current
  version or an active run uses (`tableInUse`). The engine runs a ready data step inside the
  server (`engine/data-step.ts`, `runDataStep`) in one transaction: it claims the step (pending →
  running, so a replayed event or a second advance does nothing), parses every value with its
  field as the field is now (the table locked `FOR SHARE`), writes through `writeRow` or finds rows
  in creation order, then completes or fails the step with the owner-facing reason (naming the
  field and value), so a step never writes part of a row and writes it once; the rows it wrote
  are published on `DataEvents` after the commit. A Tool step (`ToolStep`, `tool-steps.ts`)
  calls one action of an installed HTTP tool:
  `toolId`, `action` and `inputs`, one `{ param, source }` per wired top-level parameter of the
  action's `inputSchema` (an array, so a parameter named `__proto__` is just a name). Picking an
  action (`pickAction`) drops inputs it doesn't have and wires each required parameter to the
  nearest chat or agent step upstream, which is asked for a value named after the parameter
  (`outputNameFor`, shared with data steps), with the parameter's description and type as the
  expected output's description; optional ones start unwired. It gives `result` (the call's
  text) and each top-level field of its structured result, or, without one, of its text when
  that is a JSON object (text as is, anything else as JSON, so a list feeds a loop; names a
  value can't take are dropped). Those fields are known only once it answers, so `sourceFields`
  is `open` for it; `validateToolSteps` checks a reference against the action's `outputSchema`
  when it has one, and checks the steps against the owner's tools as they are (tool and action
  still there, an HTTP tool: "Tool steps run HTTP tools; use an agent for runner tools",
  required parameters wired, no unknown or doubled one, literals that fit their type).
  `workflows.update` refuses a tool that isn't the owner's, `runs.start` (and the scheduler,
  through `runIssues`) a step it flags, and `tools.delete` (`CONFLICT`, `toolHolder`) a tool a
  workflow's current version uses. At run time the engine resolves each input (`toolValues`: a
  literal; an upstream value, `""` when that node didn't give the field; or the skipped node's
  name) and `coerceArguments` (`tools/arguments.ts`) turns it into the parameter's JSON type
  (`"3"` → 3, `"TRUE"` → true, JSON for arrays and objects); a value that doesn't fit, or a
  required parameter without one ("“name” has no value (“Brief” was skipped)"), fails the step
  without calling the tool, and an optional one without a value is left out. A ready Tool step
  is claimed (pending → running) and its call goes out detached (`track("tool:<step run id>")`):
  nothing in `advance` or `onHarnessEvent` waits on a tool. When it settles the step completes
  (and the run goes on) or fails with the run; an `isError` result fails it with its first 500
  characters. The connector's 5-minute deadline bounds a call. A call is never made twice
  (product rule): `stop()` aborts the calls under way and writes nothing, and `recover()` fails
  every Tool step left `running` with no call under way in this process with "Dispand
  restarted during this tool call: check the tool before running again"; a call that settles
  after that changes nothing (`complete` and `fail` only touch open steps). The call itself goes
  through `InstalledTools` (`tools/executor.ts`), the one way Dispand calls an installed
  tool: the owner's row (by id and owner), `toolTarget` opening the headers for that call only,
  `ToolConnector.callAction`, and a short reason on failure; `connectorToolExecutor` (the
  engine's `ToolExecutor`, built by `createEngine` from `deps.connector`, the app's guarded
  connector) adds the step's coercion and outputs on top. The `mcpToolCaller`
  (cloud agents' tool calls) is meant to call `InstalledTools.find` and `.call` too. A chat or agent step's session gets the
  descriptions from the tables as they are when it starts. The editor's canvas (`apps/web/src/components/workflow`) lays the graph out top to bottom with dagre (`layout.ts`) and changes it only through the model's operations (`addStep` after a node or on a link, `connect`, which refuses loops and links into the trigger, `disconnect`, `removeStep`); a condition's card has a Then and an Else handle and "+", its links show their branch, and a condition added on a link continues to the link's end on Then, so the workflow stays saveable; its panel (`panels/ConditionPanel.tsx`) picks an upstream value, the operator and what it compares with; a loop is one node drawn as a dashed box around its body (`layout.ts` lays the body out first, then the box as one node of the top-level graph, since dagre can't link to a group), the body's cards are its children (`parentId`), its first step comes from the "+" inside the empty box, no "+" inside a loop offers "For each" (`addStep` refuses nesting), and its panel (`panels/LoopPanel.tsx`) picks the list and the cap; every node's size is declared to React Flow (`width`, `height`, `measured`): the editor builds new node objects on every edit, and without it each stays `visibility: hidden` until the ResizeObserver reports again, which sometimes never came; the run page (`components/runs/RunSteps.tsx`) groups a loop's body steps by iteration ("Iteration 2 of 5"), only the latest open; a data step's panel (`panels/DataPanel.tsx`) picks the action and the table (loaded with `tables.get` for the derived descriptions and `validateDataSteps`, whose issues show with `validateWorkflow`'s once every table has answered), then the fields it sets (ticking one wires it by `setDataFields`) or its filters; every value either panel takes from upstream goes through one picker (`SourcePicker.tsx`: an upstream step, the name a chat or agent step is asked for, or a typed value fitted to the field), and rewiring keeps the name, so the value moves from one agent's expected outputs to the other's; a schedule trigger's panel (`panels/ScheduleTriggerPanel.tsx`) offers presets (`toCron` / `fromCron`; any other cron opens on Custom, where a cron `cronProblem` refuses is shown and never saved), a timezone among `Intl.supportedValuesOf("timeZone")`, the next three runs in that timezone, a Paused switch (`workflows.setScheduleEnabled`) and the latest fires; runs lists say "Manual" or "Scheduled for <time>" (Paris time); what runs next is decided by one pure function, `nextActions` (`engine/next-actions.ts`), that `Engine.advance` only applies: a pending node whose incoming links are all decided runs when one of them is live (its source succeeded, on the branch a condition took) and is `skipped` when none is, so a join waits for all its branches and runs once; a button or a condition completes there (a condition that can't compare fails its step and the run); every top-level node succeeded or skipped finishes the run. A skipped node's fields that a prompt references are filled in as empty text (`valuesFor`). Each step run has an `iteration` (0 outside loops): a run starts with a row per top-level node; a ready loop fails when its list isn't a JSON array or is longer than its cap (before any iteration), completes with `count` "0" when it is empty, and otherwise goes `running` (no session) and opens iteration 1, a `pending` row per body step with that iteration (`open-iteration`, inserted once); its body then follows the same rules within the iteration, reading that iteration's rows and the item (re-read from the list's stored value), and once every body row is succeeded or skipped the next iteration opens, or the loop completes with `count` and `results` (over 1,000,000 characters of `results`, it fails instead; a failed body step fails its loop and the run). So each iteration's session has its own row and folder, and a run in the middle of a loop recovers like any other. Deleting a workflow locks it, so no run starts meanwhile. `Engine` (`packages/domain/src/engine`) keeps runs,
  step runs, `messages` and `questions` in PostgreSQL and drives sessions through a
  `HarnessAdapter` (`CliHarnessAdapter` over the hub; `getEngine` wires the hub to it).
  `onHarnessEvent` only writes and returns; replays are dropped per step run by `event_seq`
  (the highest runner seq handled, raised in the same transaction as the event's effects), and
  only the session's own runner may report on it. Starts, answers and chat messages
  carry `delivered_at` (`start_delivered_at`), set once the hub wrote them. On boot `recover()`
  continues active runs; on every runner `hello`, once caught up (a session that ended meanwhile
  is closed by then), `reconcile` handles each open session on it: live → undelivered answers and
  messages go now; lost after its start was written (or after any event of it: the start
  arrived though its write wasn't recorded) → resumed from its CLI session id with a prompt
  carrying every answer and chat message written since its start or last resume (no event proves
  which of them it read, so it may get some twice; a write still under way then doesn't mark
  its row delivered; pending questions become `orphaned`: their
  answer goes as a message); start never written → sent once. Answers and chat messages asked
  for during a reconcile, or while the runner's "session is not running" error resumes the
  session, are delivered after it, against the rows it left; "already running" counts as a
  delivered start. A completed step's
  pending questions expire, and a resumed session's new question expires the orphaned ones.
  Events for closed steps are ignored. `runs.stream` is an oRPC event iterator: a snapshot,
  then every changed row. Every stream (`runs.stream`, `questions.stream`) sends an SSE comment
  after 25 s without an event (`STREAM_HEARTBEAT_MS` in `apps/web/src/server/rpc.ts`), so no
  proxy idle timeout cuts it; the oRPC client ignores comments.
- **Schedules:** saving a workflow whose trigger is a schedule keeps its `schedules` row in the
  same transaction (`next_fire_at`, `last_checked_at` reset only when the cron or timezone
  changed; a cron `cronProblem` refuses is a `BAD_REQUEST`); a manual trigger deletes it.
  `workflows.setScheduleEnabled` pauses it, and resuming fires from then on, without catching up
  the pause. `Scheduler` (`engine/scheduler.ts`, one per process, started after
  `engine.recover()`, stopped before the database closes) ticks at once, then every 15 s
  (`SCHEDULER_TICK_MS`). Each tick is one transaction: it claims up to 20 due enabled rows
  `FOR UPDATE SKIP LOCKED`, takes the latest fire in `(last_checked_at, now]` (missed fires
  coalesce into one), and records it in `schedule_fires`, unique on `(workflow_id,
  scheduled_for)`, so a time never fires twice: `skipped-overlap` while a run of the workflow is
  going, `refused` with `validateWorkflow`'s issue, otherwise `started`, with the run and its
  steps created in the same transaction (`Engine.createRun`, with `runs.trigger` `{ type:
  "schedule", scheduledFor }`). Each fire has its own savepoint: one that fails leaves its
  schedule due, and the next tick tries the same time again; otherwise `next_fire_at` moves past
  now. After the commit each started run goes on (`continueRun`, retried every tick until it
  succeeds); if the process stops first, the next boot's `recover()` does. The schedule trigger completes with `scheduled_for` (ISO 8601
  with the schedule's offset; the run's start time for a manual start). Sessions of runs fired at
  boot start when their runner says hello.
- **Jobs and triggers:** an agent owns `triggers` rows (`triggers/`): `manual` (a chat or a
  button) or `schedule` (cron and timezone, checked by `cronProblem`), each with a name,
  instructions added to the prompt, a concurrency (`parallel` or `one-at-a-time`) and, for a
  schedule, `next_fire_at` and `last_checked_at` with the meaning they have on `schedules`
  (reset only when the cron or timezone changed or the trigger is enabled again; a trigger keeps
  its kind). Each firing creates a Job: a row of `runs` with `source: "agent"`, no workflow, its
  `agent_id` and `trigger_id`, a `cause` (who or what made it, and its depth in a chain of Jobs;
  deeper than 10 is refused) and its own definition in `def`, built by the pure `jobDef`
  (`engine/job-def.ts`): the trigger as the firing, then one agent step whose prompt is the
  trigger's instructions (a chat trigger has no step: the conversation is the Job). The engine's
  `defOf` returns `run.def` when it is set and the workflow version otherwise, so sessions,
  questions, recovery and reconcile are the same code for both. A Job also keeps a `snapshot`
  of its agent (system prompt, model, harness, skills, tools) taken in `Engine.createJob`; its
  sessions read the snapshot, so editing the agent or the trigger never changes a Job already
  created. `jobs.start` starts a manual trigger's Job, `jobs.def` gives a Job's definition, and
  `runs.list` takes an `agentId` or a `triggerId`. An agent is never deleted under a Job still going, by itself or
  with its plugin: both paths lock its triggers and the agent in the deleting transaction
  (`jobs/active.ts`; `createJob` and the scheduler take them in the same order), so a Job being created at that moment is seen; finished Jobs and triggers
  go with the agent (cascade). The scheduler's tick makes a second claim in the same
  transaction, for due enabled schedule triggers, with the rules of workflow schedules: one
  fire per due time in `trigger_fires` (unique on `(trigger_id, scheduled_for)`),
  `skipped-overlap` when the trigger is one at a time and one of its Jobs is going, `refused`
  with the engine's message, otherwise `started` with the Job. The agent's page
  (`/settings/agents/<id>`) has three tabs: Settings, Triggers (`components/agents/TriggerList`,
  `TriggerSheet`, which reuses the schedule panel) and Jobs (`JobList`). A manual trigger goes
  on a page as a `trigger-form` widget (`widgets.trigger_id`, one per trigger and page):
  `TriggerWidget` shows its button or its chat (`ChatPanel` with `jobs.start`). A Job's
  questions are listed in Notifications with its agent.
- **Platform tools:** a Job's session gets some of Dispand's own procedures as tools.
  `platform/tools.ts` is the registry: each tool names its procedure (`rows.create` is the tool
  `rows_create`), its bundle (`data`: `tables.list`, `tables.get` and the rows procedures;
  `configure`: creating and renaming tables, creating, changing and ordering fields), what the
  agent reads about it, and how to find the tables a call touches from its input (a row or a
  field gives its table). Every other procedure is listed there as not a tool, and a test walks
  the router and fails on a procedure that is in neither list, so adding one never hands it to
  agents unnoticed. An agent has `bundles` and `dataTables` (all tables, or a list), copied into
  its Jobs' snapshot. `callPlatformTool` (`platform/call.ts`) is the one path a call takes: the
  Job must still be going, the tool's bundle and every table touched must be in the Job's
  snapshot and still on the agent (rights shrink with the agent at once and never grow after the
  Job was created), an id that names nothing is answered like a table out of scope ("Not
  found"), and the procedure then runs in process as the Job's owner (`InitialContext.job`,
  which only that function sets; `authed` reads it instead of a session). Refusals and
  procedure errors come back as words, any other failure as "The tool failed". Cloud sessions
  get these tools through `platformToolCaller` (`platform/cloud.ts`), the engine's `ToolCaller`
  in the app: the tools of the session's Job, with their JSON Schema, marked `ask: false`, so
  the cloud runner asks no permission question for them; a workflow run's session gets none.
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
- **Home and widgets:** `pages.home` returns the owner's home page with its widgets, creating
  it on the first call (a partial unique index keeps one per owner); it can't be renamed or deleted and is listed first. Other pages (`kind: "page"`, `pages.create`, `rename`, `delete`; at most 50 per owner, titles 1-100 characters, duplicates allowed) are listed under Home in the sidebar and shown at `/p/<id>` by the same `PageView`; deleting one deletes its widgets (cascade). A
  widget is a workflow form (`type: "workflow-form"`) with a layout per breakpoint (`lg`, `md`,
  `sm`: grid and columns in `packages/domain/src/pages/layout.ts`, shared with the web
  dashboard, which uses react-grid-layout). A Chat field's widget follows the latest run of its
  workflow through `runs.stream` and shows the chat's questions inline; they are counted in
  Notifications too, and answering in either place updates both. Widgets showing one run share
  its watch (`apps/web/src/lib/run-watch.ts`); at most 3 run streams are open at once and other
  runs are polled. The cap is per tab: the reverse proxy serves HTTP/2 (`deploy/README.md`), so several tabs
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
- **The runner:** a Node service run as the machine's user by the systemd user unit
  `dispand-runner.service`. `Connection` dials `/runner/ws` (backoff 1 s to 30 s), numbers
  events with a seq kept in `state/<runnerId>/state.json` (per pairing, like the backlog and
  `sessions.json`: a re-pair only rewrites `config.json`, then removes other pairings' state;
  any safe integer; the hub stores seqs as `bigint`),
  keeps unacked ones in `backlog.jsonl` (append-only, compacted as acks come, replayed after a
  restart) and resends them after `hello`, oldest first,
  keeping at most 500 events and 4 MiB in flight (half the hub's limits). While events wait,
  consecutive text deltas of a session are coalesced (up to 32k characters each); past 20,000
  events or 32 MiB waiting, every live session ends with an `error` ("Dispand unreachable"),
  only errors are kept, and no session starts until the backlog drains below half. Every event goes
  through `protocolEvents` (`apps/runner/src/sanitize.ts`) first: NUL and lone surrogates become
  U+FFFD, strings are cut to the protocol's maxima and long text deltas split, each event
  within a 1 MiB frame. Outputs are never cut: `submit_outputs` refuses oversized values back
  to the agent; nor are permission prompts: a tool input too large to show whole is denied
  without asking. `Sessions`
  starts each `session.start` in a fresh per-run folder from `resolveWorkdir`
  (`<roots[0]>/runs/<runKey>`; `SessionStart.cwd` has no other mode) through `startClaudeSession`: the Claude Agent SDK's `query` in streaming-input mode,
  running the machine's `claude` with the user's settings only (`settingSources: ["user"]`,
  never the run folder's), resuming only a CLI session the runner recorded for that run key
  (`sessions.json`). Permission prompts and
  `AskUserQuestion` become `question` events; the agent returns its outputs through the
  `submit_outputs` tool of the in-process MCP server `dispand`. `bypassPermissions` needs
  `allowBypass: true` in the machine's config. `boundary.ts` is the one permission boundary
  every session runs inside: file edits stay inside the working directory, minus any
  `.claude/` and `.mcp.json` in it (and what their symlinks, or the CLI's user settings and
  hooks, lead to), decided from real paths at
  each call by a PreToolUse hook; "always allow" stays in the session. `config.ts` keeps the
  runner's and the CLI's config out of every root and working directory. `install.sh` writes the unit
  where the user manager looks (its `XDG_CONFIG_HOME`, else `~/.config`) and passes the
  runner's config dir with `--config`.
- **Runner distribution:** `pnpm build` bundles the runner with esbuild into
  `dispand-runner.tgz` and copies it with `install/install.sh` into
  `apps/web/public/runner/` (gitignored), so the web app serves `/runner/install.sh` and
  `/runner/dispand-runner.tgz`. `apps/web` lists `@dispand/runner` as a dev
  dependency only so that the runner builds first. The install command `runners.create` shows
  passes `--server` to `install.sh` and the pairing code in `DISPAND_PAIRING_CODE`, never
  in argv.
- **Data:** PostgreSQL 18 with Drizzle. `createDb(url)` takes `postgres://…` (node-postgres)
  or `pglite://memory` / `pglite:///path` (PGlite, used by tests and e2e) and applies the
  migrations in `packages/domain/drizzle`. Local Postgres: `compose.dev.yaml`. Text sorts in
  code-point order everywhere: PGlite's collation is `C`, and both compose files initialize
  Postgres with the builtin `C.UTF-8` locale.
- **Tables (Data):** `tables`, `fields` and `rows` are owner-scoped rows; a row's values are one
  `jsonb` object keyed by field id, so renaming a field touches no row. Field types, cell
  validation, text parsing and the retype rule live in one pure module,
  `packages/domain/src/data/fields.ts` (shared with the web app). Procedures `tables.*` and
  `fields.*` (`packages/domain/src/data/tables.ts`): every schema change locks the table's row
  `FOR UPDATE`, bumps `tables.updated_at`, and is published on `DataEvents`
  (`data/events.ts`, one per process through `getDataEvents`) as `schema` after its commit, plus
  `rows` with the changed row ids when cells changed. A retype converts every cell in that
  transaction (`dryRun` only counts what converts and what clears); removing a choice clears its
  cells; deleting a field removes its key from every row. Bounds: table and field names
  1-100 characters, unique case-insensitively per owner (tables) and per table (fields); 200
  fields per table; 100 choices per single select (labels 1-100, distinct ids and labels); text
  10 000 characters, long text 100 000, URL 2 000 (`http:`/`https:`). A table always keeps at
  least one field; the field at position 0 is its primary field; `tables.create` adds a
  `Name` text field.
- **Rows (Data):** every row write, from a procedure or a Data step, goes through
  `writeRow` (`packages/domain/src/data/rows.ts`): it takes the table's row `FOR SHARE`, so it
  waits for a schema change and is then checked against the new fields (`cellSchema`), and it
  merges values with `||`, so concurrent edits of different cells both land. `rows.*` publish
  `rows` events after commit; `rows.stream` forwards the events of up to 20 of the owner's
  tables. Sort and filter (`data/query.ts`, pure) run in SQL on `rows.values`: numbers as
  numbers, a single select by choice order, dates as ISO text, text case-insensitively with
  `strpos` (so `%` and `_` are literal); empty is missing, `null`, `""` or `[]`, and sorts last;
  every order ends with creation order. `contains` takes any text, even on a URL field; other
  filter values are parsed with the field's rules; files can't be sorted. Bounds: a page
  of rows is at most 500; at most 20 filters (ANDed) and 3 sorts.
- **Data screens:** `/settings/data` lists the tables; `/settings/data/<tableId>` is the grid
  (`apps/web/src/components/data/Grid.tsx`, TanStack Table in manual mode, 100 rows a page). A
  cell edit shows at once and is sent as `rows.update` of that one cell. Every row write of a
  table (edit, new row, delete) runs in one TanStack Query mutation scope (`rowWrites`), so the
  writes reach the server in the order they were made and a slower one never overwrites a newer
  one; each response updates only the cell it saved. The row detail joins the same queue: its
  first read of the row runs there (after every write made before it opened), and a file change
  is an operation ("add these ids", "remove this one", `rows.editFiles`) that the server applies
  to the cell as stored, holding the row, never a list read earlier (`apps/web/src/components/data/row-writes.ts`). An edited row
  stays where it is, even when the edit changes its place under the sort or takes it out of the
  filter, until the list is loaded again (a reload, a change of sort or filter): rows never
  move under the owner's cursor, so a keyboard edit can't land on another row. No write re-asks
  the list: every one (the grid's, the detail's, deletes) patches its own rows in the cached
  pages (`setListCell`, `patchListRows`). Deleting acts only
  on the selected rows that are shown. A table's sort and filter live in its URL only, `?q=<RowQuery as JSON>`, with
  no saved views; `?row=<id>` opens the row detail. `parseDataSearch`
  (`apps/web/src/lib/data-search.ts`) drops what doesn't parse, so an old link still opens the
  table.
- **Attachments (Data):** an attachment cell holds attachment ids. `files.upload`
  (`packages/domain/src/data/files.ts`) stores each file at `<filesDir>/<ownerId>/<attachmentId>`
  (written to a temp name, then renamed) and its row in `attachments` (owner, table, name, size,
  sniffed type). `writeRow` accepts only ids uploaded to the same table and locks them
  `FOR SHARE`. `GET /files/<id>` (`apps/web/src/server/files.ts`, the one route outside oRPC,
  checks the session itself) serves PNG, JPEG, GIF and WebP sniffed on upload inline and
  everything else as a download, all with `nosniff` and a sandbox CSP. `sweepAttachments` runs
  on boot and hourly: it removes attachments no row of their table references, then files on disk
  with no row (a deleted table's), both after an hour; it is the one mechanism for every way a
  file stops being used. `filesDir` is `DISPAND_FILES_DIR` (production: `/data/files`, in the
  `dispand-files` volume), `.data/files` in development. Bounds: 20 files per cell,
  10 MiB per file (the production server takes 11 MiB bodies on `files.upload` only).
- **Secrets at rest:** `packages/domain/src/secrets.ts` is the one secret box (the tool headers use it too). `createSecretBox(key)`
  seals with AES-256-GCM and a random 12-byte IV into `v1.<iv>.<ciphertext+tag>` (base64url);
  `seal` and `open` take an AAD, `secretAad(table, rowId, field)`, which binds the value to where
  it is stored. Every procedure gets the box as `context.secrets`, built once from
  `ServerConfig.secretKey`. Sealed values never leave the server: views say only whether one
  is set.
- **Tools (MCP servers):** one `tools` table, MCP connector and Settings → Tools serve agents, sessions and Tool steps,
  with a catalog and runner (stdio) tools. A `tools` row (`packages/domain/src/db/schema.ts`) is
  `kind: "http"`: URL, transport (`streamable-http` or `sse`), headers sealed one by one in
  `headers_sealed` (name in lower case → sealed value, AAD `headerAad(id, name)`), the actions
  of the last listing that succeeded (`ToolAction`: runner-protocol's `McpAction` plus an
  optional `outputSchema`) and `actions_error`, the short reason the last one failed. Names are
  unique case-insensitively per owner. `ToolConnector` (`tools/mcp.ts`, `createMcpConnector`,
  `context.tools`) is the one way to call an MCP server over HTTP: `listActions` (30 s, at most
  200 actions, 64 KiB per schema) and `callAction` (5 min; text parts joined, others as
  `[image]`/`[resource <uri>]`, cut at 200,000 characters with "[truncated]", NUL and lone
  surrogates made storable), one SDK client (`@modelcontextprotocol/client` v2) per listing or
  call. Its errors are `ToolError`s with a reason made here (host, status), never the server's
  text. Redirects are followed only within the tool's origin. Everything the server sends goes
  through one screen in the connection's `fetch` before the SDK reads a byte of it
  (`tools/inbound.ts`, `screenedFetch`): at most 16 MiB per connection (every response and the
  SSE stream together), and each message (a body read whole whatever its declared type, or an
  event of a stream, told apart with the SDK's own `isJsonContentType`) refused past 100,000 JSON
  values or 200 actions (`inboundProblem`). The screen rewrites nothing; what the SDK returns has
  the tool's header values, and each word of them but a scheme name such as `Bearer`, replaced by
  "••••" field by field (`redact`: the server got them and may send them back) before anything
  reads or cuts it. A listing
  reads its pages one by one and stops past 200 actions or 64 pages; requests the server sends
  the client are dropped unanswered (Dispand offers no client capability); connecting
  included, the whole listing or call ends at its deadline or when cancelled. In production the connector's
  fetch is `guardedFetch(ownAddresses())` (`tools/network.ts`): it refuses loopback,
  unspecified and link-local addresses and the subnets of the app's own interfaces (the Compose
  network with PostgreSQL), checked on the addresses the socket connects to; development (and
  e2e) may call loopback fakes. Procedures `tools.*` (`tools/procedures.ts`): `create` saves,
  then lists the actions (a failure is stored as `actionsError`, not refused); `update` (an
  omitted header is kept, `""` removes it; a new URL or transport clears the actions, and any
  change to where or how lists them again); `refresh`; `delete` (refused while an agent, a
  skill package or a workflow's Tool step holds it: `toolHolder`); `list` and `get` give `headerNames`, never values. Headers go only to an
  `https://` URL (plain http only to loopback), and a URL can't carry credentials.
  `toolTarget` (server-only) opens the headers for a call. Settings → Tools
  (`_app.settings.tools.tsx`, `ToolSheet.tsx`) lists the tools, adds and edits them (header
  values are password fields, shown as "Set" once stored) and shows each action's parameters.
  The catalog (`tools/catalog.ts`) is a code constant: `github`
  (`https://api.githubcopilot.com/mcp/`) and `firecrawl` (`https://mcp.firecrawl.dev/v2/mcp`) are
  HTTP entries whose header templates (`Authorization: Bearer {token}`) are filled from the
  owner's settings; `fetch` (`uvx mcp-server-fetch`) and `brave-search`
  (`npx -y @brave/brave-search-mcp-server`, `BRAVE_API_KEY`) are runner entries. `tools.catalog`
  searches names and descriptions; `tools.installFromCatalog` creates an HTTP tool through the
  same `createTool` as `tools.create` (with `catalog_id`), or returns, for a runner entry, the
  `mcpServers` snippet for the runner's config with `"<your key>"` placeholders (no value is
  sent or stored). Settings → Tools
  has "Browse catalog" (`ToolCatalog.tsx`).
- **Skills:** a skill package (`skill_packages`, owner-scoped) holds one or more skills, a folder
  each with its `SKILL.md` (YAML frontmatter `name`, equal to the folder, and `description`), and
  their files (`skill_files`, `bytea`, keyed by package and `<skill>/<path>`); `skills` lists each
  package's skills. `validatePackage` (`packages/domain/src/skills/package.ts`, pure) is the one
  check every way in goes through: every path passes `isSafeRelativePath`
  (`packages/runner-protocol/src/paths.ts`, shared with the runner, which will write the files
  under its session folder: relative POSIX, no empty, `.` or `..` segment, no `\`, control
  character, `.claude` or `.mcp.json` segment, 255 characters and 10 segments at most), no two
  paths collide (case ignored), and a package is at most 500 files, 2 MiB per file and 8 MiB in
  all. `skills.create`/`update` make a user-made package of one skill named like it from a name,
  description, Markdown instructions (written as `SKILL.md`) and files (base64); an update without
  `files` keeps the stored ones. A plugin's package (`plugin_id`, from plugin installs) is
  read-only: update and delete are `FORBIDDEN`; it shows "From plugin X". `requiredToolIds` must be the owner's tools;
  until MCP tools land the owner has none, so any id is `NOT_FOUND`. Settings › Skills lists the
  packages (a row expands to its skills) and edits user-made ones in a sheet.
- **Plugins:** Settings › Plugins has Discover (every marketplace's entries, searchable, and the
  Marketplaces list: add any by `https://` Git URL or GitHub `owner/repo`, sync, last error) and Installed. A marketplace
  (`marketplaces`, owner-scoped; `claude-plugins-official` and `anthropics/skills` are built in,
  seeded at setup and by migration 0017, not removable) is a Git repository with a
  `.claude-plugin/marketplace.json`; a sync (`plugins/git.ts` `fetchGit`, then
  `marketplace.ts` `parseMarketplace`) stores its entries, and a failed one keeps them and stores
  `sync_error`. An entry's source is a path in the marketplace's repository, or a Git repository
  (`github`, `url`, `git-subdir`, with its `ref`/`sha`); any other is unsupported, with its reason.
  `plugins.preview` fetches the entry and reads it (`read-plugin.ts` `readPlugin`, pure over the
  checkout, links never followed): skills (`entry.skills`, else `skills/*`), MCP servers
  (`.mcp.json`, the manifest's `mcpServers`), agents (`agents/*.md`) and what is never imported
  (hooks, commands, `bin/`, servers running `${CLAUDE_PLUGIN_ROOT}`, links, files a skill can't
  hold, skills `validatePackage` refuses). `plugins.install` stores the plugin (`plugins`: url,
  sha, what it offered, what wasn't imported) and one read-only skill package named after it with
  the ticked skills. Ticked HTTP MCP servers become HTTP tools (only as reviewed: the server
  definitions at that commit, else `CONFLICT`; a stdio server that runs a command is refused) and
  ticked agents become a system prompt on the harness the owner picks. `plugins.update` syncs the
  marketplace, then replaces the imported skills' files with the entry's current commit;
  `plugins.uninstall` removes the plugin and its package (cascade). A marketplace with installed
  plugins can't be removed.
- **Skill sources:** a marketplace row has a `kind`. `marketplace` is the format above. A Git
  repository with no `.claude-plugin/marketplace.json` but a `skills/` folder is a `skill-repo`: one
  entry, named after the repository, read by `readPlugin` like a plugin. A `well-known` site
  (`plugins/well-known.ts`) publishes `https://<site>/.well-known/skills/index.json`
  (`{ skills: [{ name, description, files }] }`, files at `/.well-known/skills/<name>/<file>`):
  one entry, named after the host. Install downloads each listed skill over https and checks it
  as a package of its own, and its `sha` is a SHA-256 of the files. Redirects are followed only
  to the same origin (at most 3). Caps: an index of 1 MiB and 200 skills, 2 MiB per file, 32 MiB
  and 60 s per read. Add picks the kind ("Git repository", auto-detected as marketplace or skill
  repository, or "Skill site").
- **Authentication and authorization:** Better Auth (email + password) at `/api/auth`, one
  owner. Sign-up is disabled: the first-run screen calls `auth.setup`, which creates the owner
  only while no user exists. Route guards (`getAuthState` server function) send fresh installs
  to `/setup` and signed-out visitors to `/login`.
- **Web server settings** (read only in `apps/web/src/server/config.ts`; the mode comes from the build,
  never from NODE_ENV; `createAuth` sets every option Better Auth would default from NODE_ENV): `DATABASE_URL` (required), `BETTER_AUTH_SECRET`,
  `BETTER_AUTH_URL` (public URL of the app), `DISPAND_SETUP_CODE` (first-run code, 16+ characters), `DISPAND_SECRET_KEY` (32 bytes in base64, the secret box's key; changing it loses every stored secret) and `DISPAND_FILES_DIR` (attachments): required in a production build, fixed dev defaults
  otherwise. All are read from the environment; `deploy/compose.yaml` fills them from the
  `DISPAND_*` variables listed in `deploy/README.md`. `/api/rpc` demands the oRPC CSRF header (`x-csrf-token: orpc`, added by the client
  link), which cross-origin forms cannot send.
- **Build and migrations:** the web build bundles `packages/domain`, so its source-relative
  migrations path no longer exists there. `vite.config.ts` copies `packages/domain/drizzle` to
  `dist/server/drizzle` and `src/server/app.ts` passes that folder to `createDb`. PGlite stays
  external to the bundle (it loads wasm and data files next to its own code).
- **Design:** tokens in `apps/web/src/styles/tokens.css` (system font stack, neutral palette,
  one `--accent`); light/dark follow the system, the user menu stores an override in
  `localStorage`.
- **Production entry:** `pnpm build`, then `node apps/web/server.ts` (`pnpm --filter
  @dispand/web start`; `PORT`, default 3000, and `HOST`, read by `loadServerConfig` like the
  other settings): a srvx Node server for `dist/client` and the Start handler, with request
  bodies capped at 1 MiB, 11 MiB for `/api/rpc/files/upload`, `/api/rpc/skills/create` and
  `/api/rpc/skills/update` (413 when announced larger, 411 without a length). The custom server
  entry `src/server.ts` exports `loadServerConfig` and `handleRunnerUpgrade`, so the hub and the
  routes share one `getApp()`. In dev, `vite-plugin-hub.ts` hands `/runner/ws` upgrades on
  Vite's server to the same hub.
- **Upgrades:** every entry hands the raw request, synchronously, to `upgradeRunner`
  (`@dispand/domain/upgrade`), the one guarded way in: it puts an error listener on the
  socket before anything waits, and `RunnerHub.handleUpgrade` parses the target safely (400 if
  it doesn't parse, 404 if it isn't `/runner/ws`) and gives every WebSocket an error listener.
  Entries don't parse URLs or touch the socket (`upgrade-entries.test.ts` scans them).
- **Deployment:** the Docker image is published to GHCR (`ghcr.io/polystartup/dispand`), and
  `deploy/compose.yaml` is the reference Compose project (the app and PostgreSQL, named volumes;
  `deploy/README.md`). HTTPS is done by the operator's reverse proxy, which forwards to the app's
  published port 3000, must set `X-Real-IP` and must support WebSockets on `/runner/ws`; nothing
  else may reach that port.
- **Decisions:**
  - Skills from other catalogs come only through Git repositories and `.well-known` skill sites
    Mastra has no skills catalog or API of its own: its loader lives inside
    the framework, and its Agent Builder browses skills.sh. The skills.sh API needs a Vercel OIDC
    token, so an app deployed off Vercel can't call it. Most skills.sh entries are GitHub
    repositories, which can be added directly.
  - TypeScript 6, not 7: typescript-eslint does not support 7 yet (revisit with its 7.1 support).
  - Better Auth reads only `x-real-ip` for the client IP (rate limiting): the reverse proxy in
    front of the app sets it to the peer it saw, and only that proxy may reach the app's port.
  - `routeTree.gen.ts` is committed so `typecheck` works before `build`.
