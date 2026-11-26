# Data, attachments and chat messages

- **Data:** PostgreSQL 18 with Drizzle. `openDb(url)` takes `postgres://…` (node-postgres)
  or `pglite://memory` / `pglite:///path` (PGlite, used by tests and e2e; with
  `DISPAND_TEST_DATABASE_URL=postgres://…`, a server for these tests only, the domain tests run
  there instead, a database per worker made afresh, behind a pool, where transactions interleave;
  those that record statements need PGlite), `migrateDb` applies
  the migrations in `packages/domain/drizzle`, and `createDb(url)` does both. A connection the
  server ends (a restart, a failover, `idle_session_timeout`) doesn't end the process: every
  node-postgres pool goes through `openDb`, which listens for `error` on the pool and on each
  client it opens (a database adapter's pool that already listens keeps its own listener), logs
  and counts an idle one's loss by kind (`dispand.db.connections.lost`), and fails only the
  statement that was using it; the pool opens another connection on the next query
  (`db/connection-loss.test.ts` lists the files that load node-postgres). The database lock of the
  server's own start (`lockDatabase`, App startup) is the one connection outside a pool: it listens
  for `error` too, logs a loss once (`database lock lost`), and the process ends (App startup). Local Postgres: `compose.dev.yaml`. Text sorts in
  code-point order everywhere: PGlite's collation is `C`, and both compose files initialize
  Postgres with the builtin `C.UTF-8` locale. Every time column is `timestamp with time zone`
  (migration 0133), so a time reads the same whatever the zones of Node and of the database
  session that wrote it; tests run the database session outside UTC, and `db/time-zones.test.ts`
  refuses a column without its zone.
- **Tables (Data):** `tables`, `fields` and `rows` are owner-scoped rows; tables, and the roots,
  events, attachments and memories, also belong to a workspace (`workspace_id`, from the table,
  run or agent they come from), and a primitive trigger fires only on its agent's workspace's
  events and tables. A row's values are one
  `jsonb` object keyed by field id, so renaming a field touches no row. Field types, cell
  validation, text parsing and the retype rule live in one pure module,
  `packages/domain/src/data/fields.ts` (shared with the web app). Procedures `tables.*` and
  `fields.*` (`packages/domain/src/data/tables.ts`): every schema change locks the table's row
  `FOR UPDATE`, bumps `tables.updated_at`, and is published on `DataEvents`
  (`data/events.ts`, one per app) as `schema` after its commit, plus
  `rows` with the changed row ids when cells changed. A retype converts every cell in that
  transaction (`dryRun` only counts what converts and what clears); removing a choice clears its
  cells; deleting a field removes its key from every row. Bounds: table and field names
  1-100 characters, unique case-insensitively per owner (tables) and per table (fields); 200
  fields per table; 100 choices per single select (labels 1-100, distinct ids and labels); text
  10 000 characters, long text 100 000, URL 2 000 (`http:`/`https:`). A table always keeps at
  least one field; the field at position 0 is its primary field; `tables.create` adds a
  `Name` text field. A `reference` field names a table (`fields.references_table_id`, set when it
  is created, never by a retype) and its cell holds the id of one of that table's rows.
  `writeRow` checks the row exists in that table, the owner's, and holds it `FOR SHARE`;
  deleting rows clears the references to them through `writeRow` in the same transaction
  (`clearReferences`); a table another table's reference field names can't be deleted.
  `rows.list` and `rows.get` give `references`, each named row's first field as text. A
  table can be `primitive` (its row writes become events, node C) with a parent:
  `tables.setPrimitive` sets `tables.parent_field_id` (its reference field naming the parent
  table, created when it has none) and `parent_required`. With a required parent, `writeRow`
  refuses a new row without one and any write that empties it, deleting a parent row with
  children is a `CONFLICT` with their count, and the parent field can't be deleted or retyped.
  Each write of a primitive table's row appends one row to the `events` outbox in the write's
  transaction (`recordEvent`, a rollback leaves none): `created` with the values set,
  `updated` with the fields that changed and their values before and after (a write that
  changes nothing makes none), `deleted` with every field's last value, and the `actor`: the
  signed-in user, the Job whose tool wrote it, or the Data step (`writeRow` requires it;
  `actorOf` reads it from a procedure's context). Clearing references to deleted rows is an
  event of each referring row, by the deleter. `processed_at` is set once the scheduler has
  matched the event to triggers (see Jobs).
  Questions and Approvals are a built-in primitive (`engine/interactions.ts`): asking,
  answering and expiring one appends an `events` row in the same transaction, its `table_id`
  the built-in kind `interaction`, its row the item's id, its operation `created`, `answered` or
  `expired`, and its `after` the item's kind and the asking run, agent and step, never its text,
  options or answer. It belongs to the asking Job's root, whoever wrote it (`root_id`), so a
  paused root's interactions wait with its other events. No trigger watches them: a
  `primitive` trigger on `interaction` is refused (`triggers.invalid.interaction`), and a
  plugin's is skipped. `dispand.events.recorded` counts events by kind and operation.
  Jobs are a built-in primitive too (`engine/jobs-events.ts`): `createJob` and `finishRun`
  append an `events` row in their transaction for each Job (`runs.source = "agent"`), its
  `table_id` the built-in kind `job`, its row the Job, its operation `created`, `finished` (it
  succeeded) or `failed` (it failed or was stopped), its `after` the Job's agent, trigger, cause's
  kind and status, never its result, error or transcript, its actor the Job itself and its
  `root_id` the Job's root. They are events, not Audit rows (the Job's life is audited already).
  We decided any agent may have a `primitive` trigger on `job` with those operations (no
  fields, no bundle: it reads ids and a status); its tools declare no table, and `lostScope`
  takes nothing from such a Job. At dispatch a Job's own agent is `skipped-same-agent` (the
  event's actor is the Job), and a fired Job is the next link of the Job's chain in its root, so
  Jobs firing on Jobs reach that root's checkpoint like any other chain. The trigger node's
  outputs are the event's own (`jobOutputs`: `operation`, `job_id`, `agent_id`, `agent`, the
  agent's name at dispatch, `status`, and `table_id` `job`), told by `JOB_PROMPT`; reading the
  Job's result stays `jobs_get`'s, under `configure`. `dispand.events.recorded` and
  `scheduler.fire` have kind `job`.
  Every actor has its own inbox: a consult is addressed to the agent it asks once allowed
  (`questions.addressee_agent_id`, set by `openConsult`), and the inbox tools
  (`questions/inbox.ts`: `questions_list`, `questions_get`, `questions_answer`) are every agent
  Job's own, not procedures of the router (`INBOX_TOOLS`, run by `callPlatformTool` through
  their `run`, no bundle, so a Stem Job limited to its own tools has none). Each call reads
  `ownInbox` (`questions/own-inbox.ts`): pending consults addressed to the calling Job's agent,
  in its workspace, whose root is going, asked by a Job on the caller's side of `configure` (both
  snapshots), never the Job started for it. An answer (`Engine.answerFromInbox`) reads the item
  again in its transaction and settles it as the consulted Job's end does (`deliverConsult`: the
  asker's rights checked again, then `settleConsult`, pending only), with `answered_by` the
  answering agent and Job, then stops the Job started for it; of that and the Job's own end, the
  second finds nothing waiting. The asking session is told who answered: `HarnessAdapter.answer`
  takes the agent; the cloud runner words the result "Answered by the agent <name>", and a CLI
  session, whose protocol answer has no answerer, gets each question's answer followed by
  "(Answered by the agent <name>, not by the owner)" (`attributed`). A person reads an agent's
  inbox in the Inbox (`questions.list` with `agentId`), read-only. Each call has a span
  `inbox.<tool>` and counts in `dispand.inbox.calls`.
  A schema change that rewrites cells (a choice removed, a retype, a field deleted) records
  no event: it changes the table's shape, not a row someone wrote, and starts no Job.
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
  move under the owner's cursor, so a keyboard edit can't land on another row. No edit re-asks
  the list: every one (the grid's, the detail's, deletes) patches its own rows in the cached
  pages (`setListCell`, `patchListRows`). A new row is the exception: "New row" opens a form
  (`NewRowDialog.tsx`) with the table's fields (a required parent among them, files left to the
  row detail), saving it creates the row with those values in one `rows.create`, and the list is
  read again before the form closes, so no cell is active when the row arrives. The grid never holds a row the server doesn't have, so a list that refreshes,
  streams, sorts or filters has nothing to reconcile, and a trigger on `created` gets the row's
  values; cancelling creates nothing. Deleting acts only
  on the selected rows that are shown. A table's sort and filter live in its URL only, `?q=<RowQuery as JSON>`, with
  no saved views; `?row=<id>` opens the row detail. `parseDataSearch`
  (`apps/web/src/lib/data-search.ts`) drops what doesn't parse, so an old link still opens the
  table.
- **Attachments (Data):** an attachment cell holds attachment ids. `files.upload`
  (`packages/domain/src/data/files.ts`) stores each file at `<filesDir>/<ownerId>/<attachmentId>`
  (written to a temp name, then renamed) and its row in `attachments` (owner, table, name, size,
  sniffed type). Files in the MCP content of a Job's HTTP tool call (image items, embedded
  resources with a blob; the tools endpoint and a cloud Job's calls) go the same way through
  `keepJobFiles`, owned by the Job (`job_id`, no table yet), and the result's text tells the agent
  their ids. So do the files of a Job's runner tools: the CLI starts each runner tool behind the
  runner's MCP proxy (`dispand-runner mcp-proxy`, `apps/runner/src/mcp-proxy.ts`), a relay of
  JSON-RPC lines that leaves every message as it came but a `tools/call` result, whose image,
  audio and blob parts it sends (JSON, base64) to `POST /mcp/job/files` (`platform/job-files.ts`,
  route `routes/mcp/job_.files.ts`, the Job's bearer, `JOB_FILES_PATH` in the runner protocol)
  and replaces with the reply's text. A relay rather than the SDK's `Client` and `Server`: those
  answer only what the proxy implements, and the relay keeps resources, prompts, progress and the
  server's own requests as they were. Lines reach the CLI in the order the server sent them, so
  while a result's files are being kept (up to 120 s), the server's later lines wait. Its spec (the command, args, `env` and folder from the
  runner's config, and the files URL) is the `DISPAND_PROXY` variable, the Job's token
  `DISPAND_JOB_TOKEN` (Codex: `env_vars`); outside a Job it relays results untouched. A
  plugin's stdio server can start from the same spec (`plugin-servers.ts` `Launch`).
  `keepJobFiles` keeps a result whole or refuses it whole, with the reason as its text: a file
  over 10 MiB or more than 20 files (`resultRefusal`, shared with the proxy, which checks before
  sending), the Job's totals (`MAX_JOB_BYTES` 200 MiB, `MAX_JOB_FILES` 100, over every attachment
  whose `job_id` is the Job's, whatever its source, a file a table took included: we chose these as
  ten results of large files and five full results), or the organization's
  (`organizations.files_quota_bytes`, 10 GiB until set, 1 MiB to 1 TiB through
  `workspace.filesLimit`/`setFilesLimit` in MiB, organization owner only, not tools, set on the
  Harnesses page beside the checkpoint; null: no limit). `organizations.files_used_bytes` counts
  the bytes of every attachment of the organization's workspaces: the `dispand_files_usage()`
  trigger adds or subtracts each row's size in the row's own transaction (cascades included) and
  refuses an insert past the limit with SQLSTATE `P0D02`, which every writer turns into its
  refusal; a delete is never refused. Every writer inserts its rows before writing any byte, so
  a refused upload or result leaves nothing on disk. A future source of a Job's files counts by
  storing them as attachment rows with its `job_id`. A Job's checks and stores run in one
  transaction under a lock on that Job (`dispand:job-files:<run>`); refusals count in
  `dispand.attachments.refused` by `dispand.attachment.limit`. Tool steps and workflow runs'
  sessions keep none: their text has placeholders only. `writeRow` accepts ids of the same
  table, locked `FOR SHARE`, and, when a Job writes, that Job's files no table has, locked
  `FOR UPDATE` and given to the table once the row is written. `GET /files/<id>` (`apps/web/src/server/files.ts`, the one route outside oRPC,
  checks the session itself) checks the parent Job for Job-only files. Shared readers can download a file only when
  its ID appears in a user message's attachments in that Job. A draft is its uploader's,
  and table files retain their table's owner access. It serves PNG, JPEG, GIF and WebP sniffed on upload inline and
  everything else as a download, all with `nosniff` and a sandbox CSP. `sweepAttachments` runs
  on boot and hourly: it removes attachments no row of their table references, a Job's files no
  table took and no message of it carries once the Job has ended, then files on disk with no row
  (a deleted table's), all after an hour, and files of no table and no Job (held for a chat
  message never sent, or their Job deleted) after a day; it is the one mechanism for every way a
  file stops being used. `filesDir` is `DISPAND_FILES_DIR` (production: `/data/files`, in the
  `dispand-files` volume), `.data/files` in development. Bounds: 20 files per cell,
  10 MiB per file (the production server takes 11 MiB bodies on `files.upload` and `files.hold` only).
- **Chat attachments:** the composer of every chat (`components/chat/Thread.tsx`, the library's
  attachment adapter, paste and an attach button) holds each file as it is added (`files.hold`:
  an attachment row with no table and no Job, checked against the organization's total). The next
  message names their ids (`runs.sendChat` `attachmentIds`, at most 20); `engine.sendChat` gives
  them to the Job in the transaction that writes the message (`takeChatFiles`, checked against
  the Job's totals) and keeps `{id, name}` on the message (`messages.files`, migration 0083),
  which the thread shows. A file held before a chat's first message goes to the Job that message
  starts. Delivery goes through the harness: the cloud runner queues the message with its files
  and, at each model call, reads their bytes (`attachmentBytes`) into the user item (`ChatFile`):
  by first bytes, a raster image is image input, a PDF document input, UTF-8 text a text part,
  anything else (or a file gone) a line saying so, for Anthropic, OpenAI Responses and chat
  completions alike (`fileInput`). Within bounds that keep a call from being refused, which would
  end the session and every later turn (the history is sent again): an image of at most 3.75 MB,
  a PDF of at most 100 pages (`pdfPages`: pdf.js reads its current revision's page tree, once per
  attachment, in a child process with no environment, a 96 MB heap and 5 s, so a crafted PDF can't
  block or exhaust the server; one it can't read in those limits isn't sent; `pdfjs-dist` stays outside the server bundle, as its
  worker module loads beside it), text cut at 100,000 characters per file, and per call 16 MiB of
  files and 300,000 characters of text (a PDF page counts as 3,000 where the provider takes PDFs),
  the newest messages' first (`budgetFiles`); no PDF to an OpenAI-compatible server, which may
  not take one. Past them the
  file is a line too. Tokens aren't counted: these keep a chat's files well within a context
  window, not exactly to it. A CLI session's `session.send` carries `files` (attachment id
  and path, `attachmentPath`: `.dispand/attachments/<id>/file<.ext>`, `isAttachmentPath` checked
  by `chatFiles` and the protocol schema) and a text that names the paths with the original names
  as words. The runner fetches each file at `GET /runner/attachments/<id>` (runner token; served
  only for a file a message carries, of a Job with a session on that runner, `attachmentForRunner`, span
  `runner.attachment`), writes it read-only in the run folder, then hands the text to the CLI;
  if it can't, the text goes with a line saying so. The files stay with the run folder for later
  turns and resumes. Runner protocol 28.
- **Steering (protocol 33):** `HarnessAdapter.steer` sends a chat message that joins the turn
  running now (`turnId`); when that turn isn't running, it goes like `send`. Whoever holds the
  turn's state decides, atomically, so a steer that meets the turn's end is delivered once, as the
  next message: never lost, never twice. It then reports a `steer-result` event (`steered` or
  `queued`, with the caller's `requestId`). `steering(harness)` says how each harness does it
  (`interruptsTools`); every one takes the message's attachments. For a CLI session it is a
  `session.send` with `steer: { turnId, requestId }`, handled in the session's message order. Codex
  steers through the app-server's `turn/steer` (`expectedTurnId`, a `clientUserMessageId`), beside
  the running tools: the message joined the turn once Codex shows that user message; a refused
  steer, or one the turn ended without (Codex drops it on an interrupt), starts the next turn.
  Claude Code takes a message with `priority: "now"`: its CLI stops the running tools, ends its turn
  (`aborted_tools` or `aborted_streaming`) and starts the message at once (`command_lifecycle`
  `started`, or its uuid among a result's `user_message_uuids`). The runner reports the cut turn and
  that one as a single turn; a result that ends the turn otherwise first makes the steer the next
  message. As `now` is bound to no turn, the runner steers only while the turn's own message is the
  only one waiting and no question waits; a question asked while the steer is on its way makes the
  cut a turn of its own, so the engine withdraws it. A cloud session queues it under its lock: while turn `turnId` runs, the next model call
  reads it and the turn goes on until no message is left (`steered`); otherwise it starts the next
  turn.
- **One row per assistant message (protocol 41):** a message the harness takes mid-turn (steered,
  or sent while the turn's start isn't reported yet) is stored before the reply it interrupts, so
  rows can't tell where its own reply begins. The harness says so: the first `text` delta of each
  assistant message carries `newMessage` (Claude Code's top-level `message_start`, a Codex
  `agentMessage` item, a cloud model call), and the engine starts a new assistant row for it; other
  deltas join the step's last row while it is an assistant's. The runner never folds such a delta
  into the text before it, and splits it with only its first piece marked. A transcript then reads
  both messages, then both replies, in that order.
- **Secrets at rest:** `packages/domain/src/secrets.ts` is the one secret box (the tool headers use it too). `createSecretBox(key)`
  seals with AES-256-GCM and a random 12-byte IV into `v1.<iv>.<ciphertext+tag>` (base64url);
  `seal` and `open` take an AAD, `secretAad(table, rowId, field, origin?)`, which binds the value
  to where it is stored and, for a tool's header, to the origin it is sent to. Every procedure gets the box as `context.secrets`, built once from
  `ServerConfig.secretKey`. Sealed values never leave the server: views say only whether one
  is set.
