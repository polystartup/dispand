# Workflows, the engine and Jobs

- **Workflows and the engine:** a workflow (`packages/domain/src/workflows`) is a manual
  trigger (Button or Chat) or a schedule trigger (a 5-field cron read in an IANA timezone,
  Europe/Paris by default, that gives `scheduled_for`; `schedule.ts` checks it, finds its fires
  with `cron-parser`, a 02:30 that a DST change skips or repeats firing at most once that day,
  and maps it to the editor's presets) and steps (agent, condition, data) joined by edges; edges out of a condition carry
  its `branch` (`then` or `else`) and it gives `matched`, from `evaluateCondition` (`condition.ts`) on an
  upstream value. `workflows.delete` (the editor's menu, behind a confirmation) archives it
  (`archived_at`), refused while one of its runs is going: it no longer lists, opens or runs, its
  schedule and widgets go, and its runs stay as history (`workflows.get` with a run's `version`
  still reads it, and `runs.list` names it). Each save that changes it is a new
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
  descriptions from the tables as they are when it starts. The editor's canvas (`apps/web/src/components/workflow`) lays the graph out top to bottom with dagre (`layout.ts`) and changes it only through the model's operations (`addStep` after a node or on a link, `connect`, which refuses loops and links into the trigger, `disconnect`, `removeStep`); a condition's card has a Then and an Else handle and "+", its links show their branch, and a condition added on a link continues to the link's end on Then, so the workflow stays saveable; its panel (`panels/ConditionPanel.tsx`) picks an upstream value, the operator and what it compares with; a loop is one node drawn as a dashed box around its body (`layout.ts` lays the body out first, then the box as one node of the top-level graph, since dagre can't link to a group), the body's cards are its children (`parentId`), its first step comes from the "+" inside the empty box, no "+" inside a loop offers "For each" (`addStep` refuses nesting), and its panel (`panels/LoopPanel.tsx`) picks the list and the cap; every node's size is declared to React Flow (`width`, `height`, `measured`): the editor builds new node objects on every edit, and without it each stays `visibility: hidden` until the ResizeObserver reports again, which sometimes never came; the run page (`components/runs/RunSteps.tsx`) groups a loop's body steps by iteration ("Iteration 2 of 5"), only the latest open; a data step's panel (`panels/DataPanel.tsx`) picks the action and the table (loaded with `tables.get` for the derived descriptions and `validateDataSteps`, whose issues show with `validateWorkflow`'s once every table has answered), then the fields it sets (ticking one wires it by `setDataFields`) or its filters; every value either panel takes from upstream goes through one picker (`SourcePicker.tsx`: an upstream step, the name a chat or agent step is asked for, or a typed value fitted to the field), and rewiring keeps the name, so the value moves from one agent's expected outputs to the other's; a schedule trigger's panel (`panels/ScheduleTriggerPanel.tsx`) offers presets (`toCron` / `fromCron`; any other cron opens on Custom, where a cron `cronProblem` refuses is shown and never saved), a timezone `knownTimezone` accepts (any zone `Intl.DateTimeFormat` takes, `UTC` included; `Intl.supportedValuesOf("timeZone")` only suggests), the next three runs in that timezone, a Paused switch (`workflows.setScheduleEnabled`) and the latest fires; runs lists say "Manual" or "Scheduled for <time>" (Paris time); what runs next is decided by one pure function, `nextActions` (`engine/next-actions.ts`), that `Engine.advance` only applies: a pending node whose incoming links are all decided runs when one of them is live (its source succeeded, on the branch a condition took) and is `skipped` when none is, so a join waits for all its branches and runs once; a button or a condition completes there (a condition that can't compare fails its step and the run); every top-level node succeeded or skipped finishes the run. A skipped node's fields that a prompt references are filled in as empty text (`valuesFor`). Each step run has an `iteration` (0 outside loops): a run starts with a row per top-level node; a ready loop fails when its list isn't a JSON array or is longer than its cap (before any iteration), completes with `count` "0" when it is empty, and otherwise goes `running` (no session) and opens iteration 1, a `pending` row per body step with that iteration (`open-iteration`, inserted once); its body then follows the same rules within the iteration, reading that iteration's rows and the item (re-read from the list's stored value), and once every body row is succeeded or skipped the next iteration opens, or the loop completes with `count` and `results` (over 1,000,000 characters of `results`, it fails instead; a failed body step fails its loop and the run). So each iteration's session has its own row and folder, and a run in the middle of a loop recovers like any other. Deleting a workflow locks it, so no run starts meanwhile. `Engine` (`packages/domain/src/engine`) keeps runs,
  step runs, `messages` and `questions` in PostgreSQL and drives sessions through a
  `HarnessAdapter` (`CliHarnessAdapter` over the hub; `createEngine` wires the hub to it).
  Every transaction that ends a run's steps or changes its row locks the run first (`lockRun`,
  `FOR NO KEY UPDATE`): its root's key share, a consulted Job's asker, the run, then its steps
  and questions, then their harness, so two paths on one run (a stop and a step's end, an
  answer and a stop) wait for each other instead of deadlocking. One that locks several runs (an
  agent deleted, consults revoked, a checkpoint declined) takes them and their askers by consult
  depth, then id (`lockRuns`). `endStep`, `reopen`, `finishRun` and `syncWaiting` throw in a
  transaction that didn't lock the run (`expectRunLocked`). What counts a root's Jobs, pauses or
  settles it, opens a consult in it or moves a chat out of it holds the root (`lockRoot`,
  `FOR NO KEY UPDATE`, taken before any run, or it throws; `lockRootOf` follows a chat that moved
  meanwhile), never `FOR UPDATE`: a run's root key share never waits on it, so a consulted Job
  still in the root its chat moved out of and that chat are locked in either order. Only
  `lockRoot` and `lockRun` lock a root (`root-locks.test.ts`).
  `onHarnessEvent` only writes and returns; replays are dropped per step run by `event_seq`
  (the highest runner seq handled, raised in the same transaction as the event's effects), and
  only the session's own runner may report on it. Starts, answers and chat messages
  carry `delivered_at` (`start_delivered_at`), set once the hub wrote them. An answer or a chat
  message is claimed right before it goes (`claimInputs` sets `delivering` where it is still
  undelivered and unclaimed): of the paths that decided on a row read earlier, only the first to
  claim it sends it. A resume's prompt claims what it carries the same way, taking over writes
  still under way. A write that didn't reach the session, or went to one lost meanwhile, gives
  its claim back, and so does a resume whose start wasn't written; a claim of a process that
  stopped is free again. A session's deliveries go one after another in the order they were
  asked for (`inSession`), whatever each awaits before its write. On boot `recover()`
  continues active runs; on every runner `hello`, once caught up (a session that ended meanwhile
  is closed by then), `reconcile` handles each open session on it: live → undelivered answers and
  messages go now; lost after its start was written (or after any event of it: the start
  arrived though its write wasn't recorded) → resumed from its CLI session id with a prompt
  carrying every answer and chat message written since its start or last resume (no event proves
  which of them it read, so it may get some twice; a write still under way then gives its row
  back; pending questions become `orphaned`: their
  answer goes as a message); start never written → sent once. It decides on each step once no
  start of it is under way (it waits for one that is), under its own claim of the session's start
  (`claimSettled`). Each start records the runner connection it was written on
  (`start_connection`, from `RunnerHub.send`; the cloud runner's own for a cloud session), and the
  hub reconciles each connection once, as it turns ready: a session missing from that report whose
  start was written on that very connection came after the report and is left alone; one written
  on an earlier connection, or on none known (before this was recorded), was lost. No clock is
  compared. Every start is claimed in the process first
  (`claimStart`), then reads its step again: one decided on a row read before another start of
  it was written sends nothing. Answers and chat messages asked
  for during a reconcile, or while the runner's "session is not running" error resumes the
  session, wait in their turn and go after it, against the rows it left; "already running" counts as a
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
  the pause. `Scheduler` (`engine/scheduler.ts`, one per app, started after
  `engine.recover()`, stopped before the database closes, once its tick and its poll walks under
  way have ended) ticks at once, then every 15 s (`SCHEDULER_TICK_MS`), never two at once and
  never waiting for a poll's walk (poll triggers, below). Each tick is one transaction: it claims up to 20 due enabled rows
  `FOR UPDATE SKIP LOCKED`, takes the latest fire in `(last_checked_at, now]` (missed fires
  coalesce into one), and records it in `schedule_fires`, unique on `(workflow_id,
  scheduled_for)`, so a time never fires twice: `skipped-overlap` while a run of the workflow is
  going, `refused` with `validateWorkflow`'s issue, otherwise `started`, with the run and its
  steps created in the same transaction (`Engine.createRun`, with `runs.trigger` `{ type:
  "schedule", scheduledFor }`). Each fire has its own savepoint: one that fails leaves its
  schedule due, and the next tick tries the same time again; otherwise `next_fire_at` moves past
  now. After the commit each started run goes on (`continueRun`, retried every tick until it
  succeeds), without waiting for the tick's polls; if the process stops first, the next boot's `recover()` does. The schedule trigger completes with `scheduled_for` (ISO 8601
  with the schedule's offset; the run's start time for a manual start). Sessions of runs fired at
  boot start when their runner says hello.
- **Jobs and triggers:** an agent owns `triggers` rows (`triggers/`): `manual` (a chat or a
  button) or `schedule` (cron and timezone, checked by `cronProblem`), each with a name,
  instructions added to the prompt, a concurrency (`parallel` or `one-at-a-time`) and, for a
  schedule, `next_fire_at` and `last_checked_at` with the meaning they have on `schedules`
  (reset only when the cron or timezone changed or the trigger is enabled again; a trigger keeps
  its kind). Each firing creates a Job: a row of `runs` with `source: "agent"`, no workflow, its
  `agent_id` and `trigger_id`, a `cause` (who or what made it, and its depth in a chain of Jobs,
  for information: there is no limit of depth), its root cause (`root_id`, below) and its own definition in `def`, built by the pure `jobDef`
  (`engine/job-def.ts`): the trigger as the firing, then one agent step whose prompt is the
  trigger's instructions (a chat trigger has no step: the conversation is the Job; its session's
  prompt is the instructions, and with none every harness starts it waiting between turns, so the
  owner's first message is its first turn). The engine's
  `defOf` returns `run.def` when it is set and the workflow version otherwise, so sessions,
  questions, recovery and reconcile are the same code for both. A Job also keeps a `snapshot`
  of its agent (system prompt, model, harness, skills, tools, the agents it may consult) taken in `Engine.createJob`; its
  sessions read the snapshot, so editing the agent or the trigger never changes a Job already
  created. An agent's `description` says what it is for, its `consult_mode` which agents it may
  consult (`consultRights` in `agents/consults.ts`): none, every agent the pair rule allows in its
  workspace (auto, at most 50 by name), or those `agent_consults` lists (whitelist; the list is
  kept in every mode). An entry is made only
  between two agents that both have `configure` or neither has (`pairProblem`), and goes with
  either agent; one a later bundle change puts across that line is kept and shown inactive.
  A Job's session gets an `ask` tool listing them (`StartParams.askTargets`, kind `agent`; a runner
  session's start carries at most 50, by name; since protocol 35 the one tool for agents and
  people, made once in `packages/runner-protocol/src/ask.ts` and offered as a tool of the runner's
  `dispand` server on Claude Code, a dynamic tool on Codex and a built-in of the cloud loop, which
  asks only those listed). An ask to an agent sends the questions as one text (`renderAskText`);
  an ask to a person is a `choice` question whose `to` names them, which the server never stores
  (outside a chat it is routed by `firstHop` in `engine/routing.ts`, which writes the question's
  `addressee_id` and its hop in `route`):
  an ask to an agent is a `questions` row of kind `consult` (protocol 11) that `Engine.openConsult` checks
  (`consultProblem`) and answers at once when refused, or turns into a Job of the consulted agent
  with no trigger (`RunTrigger` `consult`, `cause` the asking Job, the asking Job's root; its
  prompt is `CONSULT_PROMPT`). A consult asked while its root is paused waits with no Job until the
  root goes on (or `recover()`). When that Job ends, `finishRun` answers the row in the same
  transaction (`answerConsult`); every read of answers to send checks the rights again
  (`deliveryProblem`). A consult row that expires (its asker stopped, failed, or a resumed session
  asked again) stops its consulted run, recursively. `agents.update`
  calls `Engine.endConsults` in its transaction: the consults on either side of the agent that its
  pair no longer allows end there, with the reason. The owner sees consults, read-only
  (`jobs/consults.ts`): `jobs.consults` gives a Job's page the consults it asked (the agent, the state, the
  consulted Job to open, the question and the answer or why there is none) and the one that made it;
  `runs.list` gives each Job `waitingOn` (the agent its pending consult asks) and `consultedBy`;
  in a chat a consult is one line naming the agent, not a question to answer.
  `jobs.start` starts a manual trigger's Job (with the browser's `timezone` when it has one, kept in the run's `{ type: "manual", timezone }` firing and put in the Job's system prompt by `timezonePrompt`, so the Assistant gives the owner times in their zone), `jobs.def` gives a Job's definition, `jobs.list`
  the latest 50 Jobs (no workflow run) with their cause and the ids of their pending Questions,
  `jobs.get` one Job with a page of its transcript (`offset`, `limit` up to 200, and
  `totalMessages`) and its Questions; these three and `workflows.list` are `configure` reads, so
  the Assistant answers from them. A transcript or a definition holds whatever its Job read,
  so only a Job on every table reads one (its tool names the table `*`, which no list holds); a
  poll item's id stays out of `cause`; `runs.*` stay the owner's.
  `runs.list` takes an `agentId`, a `triggerId` and `kind: "chat"` (the Jobs whose own definition opens with a chat), and gives each run a `title`: its first message's first 80 characters, whitespace folded, null before one. Deleting an agent keeps its Jobs (`Engine.deleteAgents`, the one
  path for `agents.delete` and agents selected in `plugins.uninstall`): in the deleting transaction it takes the consult
  lock, then locks the agent's triggers and the agent (`createJob` and the scheduler take them in
  the same order, so a Job being created at that moment is seen or then finds no agent), stops
  each of its Jobs still going as `runs.stop` does, copies the agent's name as it is then into
  `runs.agent_name`, deletes the agent (`runs.agent_id` is `ON DELETE SET NULL`), and ends the
  consults in flight that lost their entry (`endConsults`). The name is copied at the delete,
  not at the Job's creation, so a rename in between shows; every path that deletes agents with
  Jobs goes through it. Everything hanging off `runs` (steps, messages, Questions and Approvals,
  proposals, consult rows, interaction events, attachments' `job_id`) stays with the Job; only the
  agent's configuration goes with it (cascade): its triggers (their fires, polls and poll items,
  and widgets on them), skills, tools, consult entries on either side and its memory. A Job whose agent is
  gone never starts a session (`openSession` fails its step) and has no tooling; its Job token is
  refused (`jobOfToken`). Its views name the agent with `jobs/agent-name.ts`: `jobs.list` and
  `jobs.get` (`agentName`), `runs.*` (`deletedAgentName`), the Inbox (`agent.name`, `agent.id`
  null), consult lines and the checkpoint's agents, all as "<name> (Deleted)". `plugins.uninstall` uses the same deletion path for selected agents; unticked agents and their Jobs stay. The scheduler's tick makes a second claim in the same
  transaction, for due enabled schedule triggers, with the rules of workflow schedules: one
  fire per due time in `trigger_fires` (unique on `(trigger_id, scheduled_for)`),
  `skipped-overlap` when the trigger is one at a time and one of its Jobs is going, `refused`
  with the engine's message, otherwise `started` with the Job. A third claim takes the
  outbox: first, for each trigger with `deferred` fires in `event_fires`, as many of its
  oldest as it has room for (so one trigger's backlog never holds up another's), then up to 100
  unprocessed `events` (`FOR UPDATE SKIP LOCKED`), each matched against the owner's enabled
  `primitive` triggers (`{ tableId, operations, fields? }`: an update fires only when one of
  `fields` changed). Each match is one `event_fires` row (unique on `(trigger_id, event_id)`)
  and the event is marked processed in the same transaction, so two schedulers never make an
  event's Job twice. Each fire reads its trigger again under `FOR NO KEY UPDATE`, so no two
  schedulers check its limits at once, and is `stopped` when its root cause was declined at a
  checkpoint, `refused` when the trigger is off or no longer
  watches the change, `skipped-same-agent` when the write was by a Job of the trigger's own
  agent, `out-of-scope` when the agent no longer has `data` on the event's table (a
  table that stopped being primitive, or was deleted, makes no more events), `deferred`
  while the trigger has started `rate_cap` Jobs in the last hour (default 60, set on the
  trigger) or, one at a time, has a Job going, and otherwise `started`. The Job's cause is
  `event` with its depth (the writing Job's plus one, 0 for a person or a workflow) and the
  chain's first Job (`rootJobId`). The trigger node's outputs are the change (`operation`, `table_id`,
  `row_id`, `changed_field_ids`, `before`, `after`, JSON for the last three), carried in the
  run's firing and written after the trigger's instructions (`CHANGE_PROMPT`); every start of
  such a Job's session (the first, a resend once its runner is back, a resume) first checks
  that its agent still has `data` on the table that changed, and fails the step otherwise, so a
  revoked table's values are never sent; a row's
  values never reach telemetry, whose `scheduler.fire` span has kind `event`. Creating or
  changing a primitive trigger checks that the table is the owner's and primitive, the fields
  are its own, and the agent has `data` on it whenever the trigger is on (an off trigger is
  checked when it is turned on again); the trigger
  tools declare the watched table (and, on a change, the one watched before), so a Job limited
  to some tables can't propose a trigger on another. The trigger sheet's "Table change" kind
  (`PrimitiveTriggerPanel`) picks a primitive table (`tables.list` gives `primitive`), the
  changes, for a changed row any field or some, the hour's cap, and lists the latest events
  with what each did. A `poll` trigger (`{ toolId, action, arguments, itemsPath, idPath,
  interval }`, interval in seconds, 60 to a day, default 300; migration 0045) makes a tool's
  list or search action an event source. Creating or changing one, while it is on, checks
  `pollProblem` (`tools/pollable.ts`): the tool is the owner's, its agent has it, the action is
  `isPollable`. Its `next_fire_at` is when it is due (now when it is made, changed or turned on
  again), its `last_checked_at` when its baseline was recorded (null again when its tool,
  action, arguments or paths change, or it is turned on again). The scheduler's tick, after its
  transaction, claims due polls in one transaction of its own (`FOR UPDATE SKIP LOCKED`, the
  next time moved an interval on, a `polls` row each, the latest 20 kept): `pollProblem` runs
  again first, and a poll that fails it is recorded `skipped` with why and calls nothing. Once
  that commits, each poll's call runs outside any transaction, for 60 s at most, without holding
  up the tick (it goes on with the runs it fired and ends; `Scheduler.tick` waits for the calls),
  all of them at once but those of one runner's tool, one after the other (the runner calls each of its tools
  once at a time), each checked again right before its call (the trigger unchanged, its tool
  there, `pollProblem`), as it may have waited for another (`tools/poll.ts`: an HTTP tool through `InstalledTools` and the connector, a runner tool
  through `hub.call`), with `{{lastPoll}}` in its arguments' strings filled with the newest
  `first_seen` of the trigger's items (the trigger's creation before any), never a call's time
  (`{{lastPollEpoch}}`: the same time in seconds since 1970, rounded down, for Gmail's `after:`),
  so a poll that recorded nothing never moves it. Its data is the result's structured content,
  else its text as JSON; its items are the list at `itemsPath` (keys between dots, empty: the
  result), each identified by a string or a number at `idPath` (items without one are counted
  and left out; all the others kept, however many: one left for later could fall before the next
  `{{lastPoll}}`). A poll may declare its `continuation` (`{ path, query?, argument }`, migration
  0046): where a result names its next page (the token at `path`, or with `query`, that query
  parameter of the link there, as Graph's `@odata.nextLink` and its `$skiptoken`; a key holding
  dots is read whole first) and the argument that takes it. It then walks one fixed query: the
  trigger's `poll_cursor` keeps the walk's `{{lastPoll}}`, when it began and the next page's
  token; each later call passes the token, a page naming the next is followed at once, one that
  doesn't ends the walk (the cursor cleared: only then does `{{lastPoll}}` move), at most 20 pages
  a poll (`MAX_WALK_PAGES`; past them the walk goes on from its token at the next interval, and the
  poll's message says so). A walk's items are first seen when it began, so the next walk's
  `ge {{lastPoll}}` repeats its boundary items, which `poll_items`' key drops. A first walk is a
  baseline across its pages (`last_checked_at` set when it ends). A next page that can't be
  followed (not text, not a link, without the parameter, past 8 KiB) fails the poll and keeps the
  cursor; a token is the server's opaque string, never in a message, a log or telemetry. Changing
  what the trigger reads clears the cursor (a new baseline); changing only its continuation keeps
  the walk's query and starts it over from its first page. A poll without a continuation
  reads one call's result, as before. A result the server cut short at its own cap
  (`_meta.result_has_more`, `hasMore` over HTTP and in `tool.called`) is polled again on the
  next tick. While this process's walks go on, its ticks claim no poll: each stays due for the
  first tick after they end, a cut-short or bounded one included, so a walk never overlaps itself
  or another poll of its runner's tool here (across processes, the claim only keeps two from
  calling one poll for the same time). The Jobs a tick's walks start go on once they all end
  (`continueRun`, retried every tick until it succeeds), and `Scheduler.stop` waits for the walks
  under way and for their Jobs to go on. A second transaction per page, the trigger locked `FOR NO KEY
  UPDATE`, records nothing when the trigger was turned off or changed meanwhile, else inserts
  each item into `poll_items` once (unique on `(trigger_id, item_id)`, with its content as JSON,
  its `first_seen` the claim's time, or its walk's start): the baseline poll as `baseline`, starting nothing, later
  ones as `deferred` (`refused` past 256 KiB), then, `pollProblem` checked again, starts a Job
  for as many as the trigger has room for (its rate cap and one at a time, as primitive
  triggers), each Job created in the same transaction as its item's `started`. A crash between
  the call and that record leaves the items unrecorded and the next poll calls again; an item
  already recorded never starts a Job again, but for one: a Job that fails on a cloud model
  provider's error that may pass (rate limited, a 408, 409 or 5xx) before calling any tool or
  asking anything hands its item back, `deferred`, in the
  transaction that ends it, with its Audit row (`poll.itemRetried`), up to 3 Jobs an item
  (`retryPollItem`, `engine/poll-retry.ts`). A runner session's failure is its CLI's words, so
  it never tells one that may pass: its item stays `started`. Each tick also tries the deferred items, trigger by
  trigger and oldest first, from their rows, whatever later polls return (`out-of-scope` when
  `pollProblem` fails then, `refused` when the trigger is off, and when its tool, action,
  arguments or paths change, so an item is never told under another source than its own). The Job's cause is `poll` (the
  trigger and the item id, depth 0), each item a root cause of its own (kind `poll`, with its own checkpoints), its firing carries the tool and the action, and the
  trigger node's outputs are `item_id` and `item`, written after the instructions
  (`POLL_PROMPT`); every start of its session first checks `pollProblem` against the agent and
  the tool as they are then, and fails the step otherwise (`refusedForScope`), so the item is
  never sent once the agent lost the tool or the action stopped being pollable. A
  `scheduler.poll` span (under the `scheduler.tick` that claimed it, which it may outlive; a tick
  that claims no poll while walks go on has `dispand.scheduler.polls_held`) and `dispand.polls`, `dispand.poll.items` and `dispand.poll.duration`
  count polls, new items and durations by tool kind and outcome (`baseline`, `polled`,
  `skipped`, `failed`), `dispand.poll.walks` and `dispand.poll.walk.pages` walks and their pages
  by how they stopped (`ended`, `bounded`), with `dispand.poll.pages` on the span, never an item,
  an argument, a result or a token. `triggers.get` gives a poll trigger's `lastPolls`, each with what it found and its new items
  (their ids are what the tool read: a Job calling it gets none). The trigger sheet's "Poll" kind
  (`PollTriggerPanel`) picks one of the agent's tools, one of its actions a poll may read now (`tools.pollable`),
  the arguments as JSON, the items' and ids' paths, the interval in minutes and the hour's cap,
  and lists the latest polls with what each found. The agent's page
  (`/settings/agents/<id>`) has three tabs: Settings, Triggers (`components/agents/TriggerList`,
  `TriggerSheet`, which reuses the schedule panel) and Jobs (`JobList`). A manual trigger goes
  on a page as a `trigger-form` widget (`widgets.trigger_id`, one per trigger and page):
  `TriggerWidget` shows its button or its chat (`ChatPanel` with `jobs.start`); disabled, it keeps its last Job without the button. The
  chat's conversation is shown on assistant-ui (`@assistant-ui/react`, pinned exactly):
  `lib/assistant-runtime.ts` is the only adapter (`threadMessages` turns the chat step's
  messages and questions into thread messages, a tool's trace and a question as tool-call
  parts; `useRunThread` feeds `useExternalStoreRuntime`), and `components/chat/Thread.tsx`
  renders it over the library's unstyled primitives, a question through `QuestionForm` and
  `questions.answer`. A Job's run page shows each step's transcript on the same thread,
  read-only (`ChatTranscript` over `useTranscript`: the step's messages only, no composer;
  its questions keep their own section). A pending Approval of a proposal carries its `proposalView` in the run's
  snapshot and stream (`runs.get`, `runs.stream`): each proposal card shows its complete scope and answers its own Question
  through `questions.answer`. Requesting changes sends a denial with the revision feedback.
  The composer keeps the conversation draft separate from that decision. The agent's text goes through `components/chat/AgentText.tsx` (the library's markdown
  primitive with a `urlTransform`, `img` and `a` overrides and `skipHtml`). Nothing else
  imports the library. The thread uses message copy actions and a jump-to-latest control;
  code fences have language headers and copy buttons. The panel uses the library's growing
  input but owns its controlled draft and send form: failed sends retain the draft, typing
  during delivery is kept, and messages can still be sent during a run. Messages use a wider
  reading layout and tool traces use compact cards. A working indicator is not shown because
  the run view does not distinguish an idle chat from a turn in progress. For the same reason,
  the runtime renders text snapshots as available (including copying the latest text) instead
  of marking the last message as streaming until the entire Job ends.
  Editing, regeneration, branching, uploads and cancellation are not exposed by this frontend
  integration: they need separate run semantics and API support. A Job's
  questions are listed in the Inbox with its agent.
- **Checkpoints** (`engine/roots.ts`): every Job has a root cause, a `roots` row (`kind`: `user`
  for a start by hand, `chat`, `schedule`, `event` for a person's or a workflow's write, `poll`),
  going, paused or stopped. `Engine.createJob`, the one place a Job is made, locks the root's row
  (`lockRoot`, before the trigger's and the agent's share locks), counts the Job in `jobs`, and
  when `jobs - counted_from` reaches the workspace's `checkpoint` (`workspace_settings` of the agent's workspace, default
  100) pauses the root and asks one Approval: a `permission` question with no session, its
  `root_id` set and `toolName` `checkpoint` (its input: what the root is, the Jobs made, the
  agents involved and since when), on the Job that reached it, or, for a chat message, in the chat.
  A Job's write keeps its run's root on its event (`events.root_id`, in `recordEvent`); a person's
  or a workflow's write gets a root of its own when the scheduler first claims it. The scheduler
  reads each event's root once, at its claim, locked (`lockRoot`, `SKIP LOCKED`) until the tick
  commits (another scheduler holding it leaves the event for a later tick): a paused root's events
  and deferred fires stay unclaimed (`notPaused`), and the event that reaches the checkpoint still
  makes every Job its triggers call for. A chat's run moves to a new root (`chat`) with each
  message of the owner (`sendChat`), unless its root is paused: the message then waits under it.
  One gate, `rootGoing(runId)`, is read wherever a session would work again: a new session's start
  (`openSession`), an answer delivered once no question is pending (`answer`), a chat message
  (`sendChat`), a lost session's resume (`resume`, `reconcile`), a start never written
  (`reconcile`) and the replay of a `pending_action` (`handOver`, which `recover` goes through).
  A paused step holds no slot: it gives its slot back or leaves the queue, and keeps what it
  would do in `pending_action` (`hold`), so its answers and messages stay undelivered; only a turn
  under way finishes. The Approval's checks ignore it: a run or step "waits" only on its own
  questions, and a stop or a step's end never expires it. Answering it (`questions.answer`,
  `Engine.answer`, with the root locked): `allow` goes on to the next checkpoint (`counted_from`
  moves to `jobs`), `allow-always` ("don't ask again for this goal") sets `dont_ask`, and both
  hand back what waited (`goOn`: each held step takes a slot for its start, answers and messages,
  or resume, and the Jobs not started yet start; `recover()` does the same for the held steps of
  a going root, should the process stop first); `deny` stops the root for good, in the answer's
  transaction: its unprocessed events are marked processed, its deferred `event_fires` close as
  `stopped`, and every unfinished Job of it is stopped as `runs.stop` does (their sessions are
  told to end once it commits, or by the runner's next reconcile). A stopped root makes no Job
  (`STOPPED`), and since its steps are failed and the gate refuses it, a reconnect or a restart
  replays nothing of it. A chat message held during a turn leaves the turn its slot until
  `turn-end`; a held start queued again is launched only once handed a slot. On boot,
  `CloudRunner.recover` runs no turn of a paused root: reported not live, it is held to resume.
  The Inbox and the chat show it as a checkpoint (`QuestionForm`'s `Checkpoint`, told apart by the
  question's `rootId`, never by its tool name): the root, its Jobs, the agents and since when, with
  "Go on", "Don't ask again for this goal" and "Stop this work". The checkpoint is set on the
  Harnesses page (`CheckpointSetting`: `workspace.checkpoint`, `workspace.setCheckpoint`, 1 to
  100,000) and by an agent through an approved proposal (`workspace_set_checkpoint`, a grant;
  `workspace_checkpoint` reads it); each root's next Job is counted against it as it is then.
  Migration 0044 gives every existing Job the root its chain counted it against. Telemetry:
  `dispand.checkpoints.reached`, `dispand.checkpoints.answered` (by `dispand.checkpoint.answer`:
  `approve`, `dont-ask`, `decline`), the `dispand.roots.paused` gauge, an `engine.checkpoint`
  span event (root id, kind and Jobs counted) and `engine.slot` events with action `hold`.
- **Harness slots:** each harness runs at most `harnesses.max_working` sessions on a turn at
  once (default 5, 1 to 100), counting every Job and workflow agent step on it. A slot is a
  step run with `working` set (`engine/slots.ts`). `Engine.openSession` takes one before it
  writes a start: `take` locks the step's row, then its harness's (`FOR NO KEY UPDATE`: a step
  written with its harness holds the harness's key share, which `FOR UPDATE` would wait on), counts the
  working steps and marks the step working, or queues it (`queued_at`, `queue_class`: `person`
  for a manual run's start or a chat message, `resume` for an answer or a lost session's
  resume, `new` otherwise). A step's
  `harness_id` is set when its row is made (a Job's from its snapshot, a workflow step's from
  its agent) and again when it becomes ready, from the agent row read once for both the slot and
  the start, so an agent moved meanwhile is charged to its new harness. A step whose session
  stops working gives its slot back (`give`): it closes (`complete`, `fail`), asks a question
  (`syncWaiting`), or, in a chat, ends its turn (`turn-end`). Work coming back takes one first:
  an answer once no question of the step is pending (`answer`), a chat message (`sendChat`), a
  lost session's resume (`resume`). What can't go yet stays undelivered (`delivered_at` null)
  and the step queues once, with what it will do in `pending_action` (`start`, `deliver` or
  `resume`); a reconcile or a held delivery sends answers and messages only to a step holding a slot (`holdsSlot`).
  `give` hands the free slots, in the same transaction, to the next queued steps of the harness
  (class, then oldest first), marked working; once that commits, `handOver` does what each
  waited for: its run advances (a start), or its undelivered answers and messages go, or its
  session resumes. A run that fails takes its queued steps out of the queue before its slot is
  handed on. The cloud harness goes through the same paths: it emits `turn-end` only once no
  message waits in its turn. `recover()` hands the free slots to the queued steps first, then
  advances every active run, which starts the steps handed a slot before the process stopped,
  and hands over again those handed one to deliver or resume. Migration 0041 charges the open agent steps and marks working those with a
  session running. `runs.list` says which runs have a step `queued`; the run page shows it on
  the step. Telemetry: `dispand.harness.working` and `dispand.harness.queued` gauges by harness
  id and kind, `dispand.harness.queue_wait` (ms, by class), an `engine.slot` span event on each
  take, give and hand-over. The limits are set on the Harnesses page (`HarnessLimits`:
  `harnesses.limits` gives each harness's limit with its sessions working and steps queued,
  its type, kind and model, and its runner's name and whether it is connected (never a key or
  a base URL: agents read it to pick a harness),
  `harnesses.setLimit` changes it) and by an agent through an approved proposal
  (`harnesses_set_limit`, a grant; `harnesses_limits` reads them). Raising a limit hands the
  freed slots out at once, in the same transaction (`Engine.setLimit`); lowering it stops nothing, and new turns wait
  until fewer work.
