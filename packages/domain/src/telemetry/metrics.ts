// Every metric instrument, with the only attributes it may carry. An instrument is created with
// `meter(...)` under one of these names; any attribute not listed here is dropped by its view.
export const METRICS = {
  "dispand.permissions.remembered": ["dispand.permission.scope", "dispand.answer.decision", "dispand.result"],
  "dispand.runner.plugin_operations": ["dispand.result"],
  "dispand.rpc.duration": ["rpc.method", "dispand.result"],
  "dispand.scheduler.ticks": [],
  "dispand.scheduler.fires": ["dispand.fire.kind", "dispand.fire.result"],
  "dispand.scheduler.lag": ["dispand.fire.kind"],
  // An outbox row appended: a table's row write (`table`) or a Question's or an Approval's (`interaction`).
  "dispand.events.recorded": ["dispand.event.kind", "dispand.event.operation"],
  "dispand.polls": ["dispand.tool.kind", "dispand.result"],
  "dispand.poll.items": ["dispand.tool.kind"],
  "dispand.poll.duration": ["dispand.tool.kind", "dispand.result"],
  "dispand.poll.walks": ["dispand.tool.kind", "dispand.result"],
  "dispand.poll.walk.pages": ["dispand.tool.kind", "dispand.result"],
  "dispand.runs.created": ["dispand.run.source", "dispand.run.trigger"],
  "dispand.runs.finished": ["dispand.run.source", "dispand.run.status"],
  "dispand.run.duration": ["dispand.run.source", "dispand.run.status"],
  "dispand.harness.events": ["dispand.event.type"],
  "dispand.questions.opened": ["dispand.question.kind"],
  "dispand.questions.answered": ["dispand.question.kind", "dispand.answer.decision", "dispand.answer.by"],
  "dispand.question.wait": ["dispand.question.kind"],
  // Consults (`engine/consults.ts`): asked, and how each ended (answered, refused, failed, stopped).
  "dispand.consults.asked": [],
  "dispand.consults.ended": ["dispand.consult.outcome"],
  "dispand.consult.wait": ["dispand.consult.outcome"],
  // The `inbox` bundle's tools (`questions/inbox.ts`).
  "dispand.inbox.calls": ["dispand.inbox.tool", "dispand.result"],
  // `proposal_apply` (`platform/call.ts`): every item made (done), some refused by an earlier call (partial), stopped at a refusal or at an item still being made, or refused at once.
  "dispand.proposals.applied": ["dispand.result"],
  // A plugin's setup run by its owner (`plugins/setup.ts`): every item made (done), stopped at a refusal, or failed.
  "dispand.plugins.setups": ["dispand.result"],
  // An Audit row written (`audit/record.ts`), by its action; `failed`: a write after the fact that didn't go through.
  "dispand.audit.rows": ["dispand.audit.action", "dispand.result"],
  // Audit rows past their owner's retention, deleted by `audit/sweep.ts`.
  "dispand.audit.swept": [],
  // A memory write (`memory/store.ts`): its scope, operation and result, never a path or a body.
  "dispand.memory.writes": ["dispand.memory.scope", "dispand.memory.op", "dispand.result"],
  // A Job's `memory_read` (`memory/tools.ts`): its scope and result.
  "dispand.memory.reads": ["dispand.memory.scope", "dispand.result"],
  // A Job's session start with its memory (`memory/read.ts`): none, whole, or cut to its budget.
  "dispand.memory.prompts": ["dispand.result"],
  // A Job's runner session start with its memory files (`memory/read.ts`): none, whole, or cut to what the frame leaves.
  "dispand.memory.files": ["dispand.result"],
  "dispand.checkpoints.reached": [],
  "dispand.checkpoints.answered": ["dispand.checkpoint.answer"],
  "dispand.roots.paused": [],
  "dispand.sessions.started": ["dispand.harness.kind", "dispand.result"],
  // Ids are the owner's few harnesses, never user content.
  "dispand.harness.working": ["dispand.harness.id", "dispand.harness.kind"],
  "dispand.harness.queued": ["dispand.harness.id", "dispand.harness.kind"],
  "dispand.harness.queue_wait": ["dispand.queue.class"],
  "dispand.runner.connections": ["dispand.result"],
  "dispand.runner.messages": ["dispand.message.type"],
  "dispand.runner.disconnects": [],
  "dispand.runner.tool_calls": ["dispand.result"],
  "dispand.runner.tool_call.duration": ["dispand.result"],
  "dispand.tool.calls": ["dispand.result"],
  // A cloud session's `read_skill` (`skills/cloud.ts`): read, not found or refused.
  "dispand.skill.reads": ["dispand.result"],
  "dispand.tool.duration": ["dispand.result"],
  // A step of an OAuth tool's sign-in (`authorize`, `callback`, `refresh`) and how it ended.
  "dispand.tool.oauth": ["dispand.oauth.step", "dispand.result"],
  "dispand.attachments.stored": ["dispand.attachment.source"],
  "dispand.attachments.refused": [],
  "dispand.attachments.swept": [],
  "dispand.model.calls": ["dispand.harness.kind", "dispand.result"],
  "dispand.model.duration": ["dispand.harness.kind", "dispand.result"],
  // The instrumentations' own (`apps/web/telemetry-preload.mjs`): methods, codes and peers, never a path or a query.
  "http.server.request.duration": ["http.request.method", "http.response.status_code", "url.scheme", "network.protocol.version", "error.type"],
  "http.client.request.duration": ["http.request.method", "http.response.status_code", "server.address", "server.port", "url.scheme", "error.type"],
  "db.client.operation.duration": ["db.system.name", "db.operation.name", "db.namespace", "server.address", "server.port", "error.type"],
  "db.client.connection.count": ["db.client.connection.state", "db.client.connection.pool.name"],
  "db.client.connection.pending_requests": ["db.client.connection.pool.name"],
  "db.client.connection.max": ["db.client.connection.pool.name"],
  "db.client.connection.idle.max": ["db.client.connection.pool.name"],
  "db.client.connection.idle.min": ["db.client.connection.pool.name"],
} as const satisfies Record<string, readonly string[]>;

export type MetricName = keyof typeof METRICS;
