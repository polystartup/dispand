# Telemetry and Audit

- **Telemetry** (`packages/domain/src/telemetry/`): OpenTelemetry's trace, log and metric
  providers, started once by the app (`startTelemetry`, guarded on `globalThis` for dev
  reloads) and stopped on shutdown. OTLP/HTTP exporters exist only when
  `OTEL_EXPORTER_OTLP_ENDPOINT` (or a signal's own endpoint) is set; log records always also
  go to the process's output (the SDK's console exporter, each as it is emitted, even with
  `OTEL_SDK_DISABLED`). Each exporter sits behind `redact.ts`. Modules take `tracer(name)` and `meter(name)` (resolved at each use, so ones
  taken at load time follow the provider) and record errors with `recordError`. `logError`
  emits a log record (printed once, by telemetry) with the trace, span and Job ids
  (`withJob`). Every procedure runs in a span named after it (`rpc/context.ts`: `rpc.method`,
  `dispand.owner.id`, `dispand.result`) and records `dispand.rpc.duration`; a Job's tool call
  passes the procedure's path. Metric instruments and their allowed attributes are listed in
  `telemetry/metrics.ts`. A cloud model call's span carries the provider's token counts, and
  `dispand.model.tokens` counts them by direction (`input` includes cached input; a provider that
  sends none adds none). A plugin's install, update and uninstall each make a `plugins.<action>`
  span (the plugin's id, `dispand.result`) and count in `dispand.plugins.actions`, never a name or
  a value. Better Auth's own spans go through the same pipeline.
  `apps/web/telemetry-preload.mjs`, loaded with `node --import` by `pnpm start`, the image and
  the dev server (`NODE_OPTIONS`), registers the HTTP, PostgreSQL and undici instrumentations
  before anything loads; the import hook wraps only `pg` and `http(s)` (wrapping every module
  breaks the router's import cycles), and `pg` is kept out of the server bundle so it can be
  hooked. `telemetry-requests.mjs` lists the requests that make no span. PGlite has no
  instrumentation: installs on it get no database spans. Each scheduler tick is the root of its own trace
  (`scheduler.tick`, one `scheduler.fire` per due schedule or trigger with its kind, result
  and lag, and a `scheduler.poll` per poll it claimed, which ends with its walk and may outlive the tick);
  a run stores the trace it was created in (`runs.trace_id`, migration 0036). A Job is
  one trace: creating it starts and ends an `engine.job` span in the trigger's or the request's
  trace and stores its id (`runs.span_id`, migration 0077), and `inJobTrace` makes every later
  span of the Job its child, linked to the span that was active (a runner message, a request, a
  restart): its session starts, its runner events, its end, its cloud sessions' model turns and
  tool calls, and its CLI sessions' calls to the Job and tools endpoints. We decided on a parent
  rather than links alone because what a Job did, from its trigger to its tool calls, is then
  read as one trace, and the Audit rows written in that work carry its id. The
  engine traces each session start (`engine.session.start`, inside the Job for a Job) and
  each runner event but text deltas (`engine.event`, which are only counted), and counts runs
  created and finished (with their duration), questions opened and answered (with their
  wait) and sessions started. The runner hub counts connection attempts by outcome,
  disconnects and messages by type, and traces each message but streamed words
  (`runner.message`, the engine's work inside it). A tool action call is a `tool.call` span
  (the tool's id, the action, how it ended) with its count and duration; a cloud session's
  model call is a `model.turn` span (the harness's kind, how the turn ended, how many tools it
  asked for) with its count and duration. Token counts are not read from the providers yet. The browser
  tests run the app instrumented and exporting to a stand-in collector
  (`apps/web/e2e/collector.mjs`); the last spec, `zzz-telemetry.spec.ts`, adds sentinel
  secrets and content and checks none appears in anything exported during the whole suite.
  The standard `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BLRP_SCHEDULE_DELAY` and
  `OTEL_METRIC_EXPORT_INTERVAL` are read by `startTelemetry` (the SDK no longer reads them).
  `deploy/otel/` is an example stack that receives it all (a collector, Prometheus with alerts,
  Jaeger, Grafana with a dashboard); `telemetry/examples.test.ts` fails when a metric, label or span
  it names is no longer one Dispand exports.
- **Audit** (`packages/domain/src/audit/`): one table, `audit` (migration 0059), and one writer,
  `recordAudit` (`record.ts`). A row holds its workspace (`workspace_id`, migration 0103: given
  by the writer, or its Job's run's), the person it is filed under (`owner_id`, set to null when
  that person is deleted: the row stays), who (`actor`: a person, a Job, an agent
  acting unattended outside a Job (a trigger's firing or poll, and the Job it makes; migration
  0104 turned earlier scheduler rows for an agent into the agent's), or the scheduler (rows
  written before that for no agent; nothing writes it now), plus `actor_agent_id` for the agent filter), the Job, the action (a closed list, `AuditAction` in
  `model.ts`), the resource (type and id), the result (`ok`, `refused`, `failed`), details and
  the trace id (`currentTraceId()` when written). Details are a strict Zod object of ids, names,
  counts and kinds (an unknown key, or a kind or id that isn't shaped as one, throws), each
  string cut at 200 characters and the whole at 2,000, any value equal to a secret the process
  opened dropped (`isOpenedSecret`, the check `telemetry/redact.ts` makes): the structure is the
  redaction. `recordAudit` writes in the transaction of the change it records, so a rolled-back
  change leaves no row; `recordAuditAfter` writes after a call outside the database and only
  logs and counts a failure. Only Jobs (`runs.source = "agent"`) have rows. Written today: the
  engine's `createJob` (`job.created`, its actor whoever called it: the person, the asking Job of
  a consult, else the scheduler), `openSession` (`job.queued` when the start waits for a slot,
  `job.started` with the harness and runner) and `resume` (`job.started`, `status: resumed`),
  `syncWaiting` (`job.waiting`, once per change of the run into `waiting`) and `finishRun`
  (`job.finished`, or `job.failed` with `reason` `stopped`, `stopped-checkpoint`,
  `consult-revoked` or `failed`, threaded from `stopIn`, never the error's words); the
  scheduler's firings that end with no Job for good (`job.skipped`, on the trigger, with the fire
  status; `deferred` and `stopped` write nothing); `recordInteraction`, in the transaction of the
  question it records (`question.asked`, `question.answered`, `question.expired`, on the question,
  with its kind and, for an answer, the decision as a kind and who answered: a person or an
  agent's Job, the actor), so a checkpoint's Approval and a consult are Questions' rows too;
  `pause` (`checkpoint.reached`, on the root, by the Job that reached it, with the count of Jobs)
  and `settleRoot` (`checkpoint.answered`, `approve`, `dont-ask` or `decline`, and on a decline the
  count of held events marked processed and of Jobs stopped: one row, the events keep their own
  record); a consult asked (`consult.asked`, by the asking Job, naming the consulted agent) and
  each way it ends (`consult.ended`, `outcome` `answered`, `refused`, `failed` or `stopped`, the
  consulted Job named, by that Job when it answered, else the asker's); and every platform call
  (`callPlatformTool`, `platform.call` with `recordAuditAfter` in a `finally`, reads, refusals and
  each item of `proposal_apply` included, so a write leaves its call's row and the row of what it
  changed): by the Job, `details.tool`, `reason` for a refusal (`unknown-tool`, `over`, `bundle`,
  `invalid`, `not-found`, `needs-proposal`, `item-used`, `refused` from a Job's own tool, or the
  procedure's `ORPCError` code in lower case), `tableId` only for a table of the owner's within
  the Job's, `proposalId` and `item` for a proposal's item; the resource from `auditResource`
  (`audit/resource.ts`: its type from the tool, its id only from what the call created or
  returned, never from a refused call's input); a Job's call of one of its agent's tools
  (`tool.call`, `audit/tool-call.ts`, written after the call by `tools/cloud.ts` for a cloud
  session and `platform/tools-mcp.ts` for a runner session, where the Job is known, not by
  `InstalledTools`, which serves Tool steps too): on the tool, by the Job, with the tool's name
  and the action, `ok`, `failed` (`reason` `tool-error` when the tool reported an error,
  `call-failed` when it couldn't be reached) or `refused` (`not-approved`, a runner call with no
  approval of its own); and each poll that ends (`poll.run`, on the trigger, by the scheduler for
  the trigger's agent, with the tool, the action, `status` `baseline`, `polled`, `skipped` or
  `failed`, and `found`, the new items it recorded; in the claim's transaction for a poll skipped
  before its call, after the call otherwise); and each event of a primitive table, when
  `recordEvent` appends it, in the write's transaction (`event.recorded`, on the row, by the
  person or the Job that wrote it, with the table's id and name, the event's id, the operation
  and how many fields changed; never a value, and nothing for a workflow step's write); and
  each memory write (`memory.written`, see Memory): a Job's
  write leaves its call's row and this one, whose event id is the one the Jobs it fires name in
  their `job.created`. A runner session's calls of the runner's own MCP
  servers never reach the server: their permission prompts are its Approvals' rows. `audit.list` (the workspace's rows, each person actor named, "you" for the reader; owner, or a `configure` Job as
  `audit_list`, which gets only rows naming no table or one of its own; keyset pages of 50 on
  `(at, id)`, the cursor carrying `at` to the microsecond) filters by actor type, agent, Job,
  action or family, resource, result and dates; `audit.traceUrl` gives the page
  `DISPAND_TRACE_URL`. Each row counts in `dispand.audit.rows` (by action, and `failed` for a
  write that didn't go through). Retention: `sweepAudit` (`sweep.ts`, span `audit.sweep`,
  counted in `dispand.audit.swept`) runs beside `sweepAttachments`, on boot and hourly, and
  deletes each workspace's rows older than its `workspace_settings.audit_retention_days` (1 to
  3650, 90 without a settings row), per workspace (`eachScope` over `auditSweepScopes`), in batches of 1,000 until none is left; events and memory are not
  swept. `workspace.auditRetention` and `workspace.setAuditRetention` are the owner's only, in
  `NOT_TOOLS`.
