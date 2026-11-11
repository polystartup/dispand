// Every metric instrument, with the only attributes it may carry. An instrument is created with
// `meter(...)` under one of these names; any attribute not listed here is dropped by its view.
export const METRICS = {
  "dispand.rpc.duration": ["rpc.method", "dispand.result"],
  "dispand.scheduler.ticks": [],
  "dispand.scheduler.fires": ["dispand.fire.kind", "dispand.fire.result"],
  "dispand.scheduler.lag": ["dispand.fire.kind"],
  "dispand.runs.created": ["dispand.run.source", "dispand.run.trigger"],
  "dispand.runs.finished": ["dispand.run.source", "dispand.run.status"],
  "dispand.run.duration": ["dispand.run.source", "dispand.run.status"],
  "dispand.harness.events": ["dispand.event.type"],
  "dispand.questions.opened": ["dispand.question.kind"],
  "dispand.questions.answered": ["dispand.question.kind", "dispand.answer.decision"],
  "dispand.question.wait": ["dispand.question.kind"],
  "dispand.sessions.started": ["dispand.harness.kind", "dispand.result"],
  // Ids are the owner's few harnesses, never user content.
  "dispand.harness.working": ["dispand.harness.id", "dispand.harness.kind"],
  "dispand.harness.queued": ["dispand.harness.id", "dispand.harness.kind"],
  "dispand.harness.queue_wait": ["dispand.queue.class"],
  "dispand.runner.connections": ["dispand.result"],
  "dispand.runner.messages": ["dispand.message.type"],
  "dispand.runner.disconnects": [],
  "dispand.tool.calls": ["dispand.result"],
  "dispand.tool.duration": ["dispand.result"],
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
