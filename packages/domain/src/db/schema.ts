import type { Answer, HarnessEvent, QuestionPayload } from "@dispand/runner-protocol";
import type { ChatItem } from "../cloud/model-client.ts";
import { sql } from "drizzle-orm";
import { type AnyPgColumn, bigint, boolean, check, customType, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import type { Harness, StartParams } from "../engine/harness.ts";
import type { Cell, Choice, FieldType } from "../data/fields.ts";
import type { Bundle, TableScope } from "../platform/bundles.ts";
import type { TriggerConfig } from "../triggers/model.ts";
import type { WidgetConfig } from "../pages/config.ts";
import type { WidgetLayout } from "../pages/layout.ts";
import type { WorkflowDef } from "../workflows/model.ts";
import type { CloudKind } from "../harnesses/cloud.ts";
import type { MarketplaceEntry, MarketplaceKind } from "../plugins/marketplace.ts";
import type { NotImported, PluginComponents } from "../plugins/read-plugin.ts";
import type { OAuthStatus, ToolAction, ToolAuth, ToolTransport } from "../tools/mcp.ts";
import type { AuditAction, AuditActor, AuditDetails, AuditResource, AuditResult } from "../audit/model.ts";

// Better Auth tables (email + password, one owner).
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Runners: machines that run CLI harnesses and dial out to the hub.
export const runners = pgTable("runners", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // SHA-256 (hex) of the runner's token; null until paired and after revocation.
  tokenHash: text("token_hash").unique(),
  clis: jsonb("clis").$type<{ claude?: string; codex?: { version: string; signedIn: boolean } }>().notNull().default({}),
  // The MCP servers in the runner's own config, by name, from its last `hello`.
  tools: jsonb("tools").$type<string[]>().notNull().default([]),
  // The runner protocol it last connected with (or was refused for); null if it never connected.
  protocolVersion: integer("protocol_version"),
  // Highest event seq the hub has handled and acked.
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  lastSeenAt: timestamp("last_seen_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const runnerPairings = pgTable("runner_pairings", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  runnerId: text("runner_id")
    .notNull()
    .references(() => runners.id, { onDelete: "cascade" }),
  // SHA-256 (hex) of the single-use pairing code.
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Harnesses: a CLI on a runner (`cli`), or a provider's API with a key (`cloud`).
export const harnesses = pgTable("harnesses", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").$type<"cli" | "cloud">().notNull().default("cli"),
  // CLI only.
  runnerId: text("runner_id").references(() => runners.id),
  kind: text("kind").$type<"claude-code" | "codex" | CloudKind>().notNull(),
  // CLI only.
  permissionMode: text("permission_mode").$type<"default" | "acceptEdits" | "plan" | "bypassPermissions">(),
  model: text("model"),
  // Cloud only. The API key is sealed (`secrets.ts`, AAD `apiKeyAad(id)`) and never leaves the server.
  baseUrl: text("base_url"),
  apiKeySealed: text("api_key_sealed"),
  systemPrompt: text("system_prompt"),
  maxTokens: integer("max_tokens"),
  effort: text("effort").$type<"low" | "medium" | "high">(),
  temperature: doublePrecision("temperature"),
  // How many of its sessions may work on a turn at once (`engine/slots.ts`); the rest queue.
  maxWorking: integer("max_working").notNull().default(5),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [check("harnesses_max_working_range", sql`${t.maxWorking} between 1 and 100`)]);

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  harnessId: text("harness_id")
    .notNull()
    .references(() => harnesses.id),
  systemPrompt: text("system_prompt").notNull(),
  // What it is for and when to consult it: other agents read it in their `consult` tool.
  description: text("description").notNull().default(""),
  // Overrides the harness's model when set.
  model: text("model"),
  // What its Jobs may do through Dispand's own tools, and on which tables (`platform/`).
  bundles: jsonb("bundles").$type<Bundle[]>().notNull().default([]),
  dataTables: jsonb("data_tables").$type<TableScope>().notNull().default(sql`'"all"'::jsonb`),
  // The plugin it came from, and its name there (`plugins/`); it goes with the plugin.
  pluginId: text("plugin_id").references((): AnyPgColumn => plugins.id, { onDelete: "cascade" }),
  pluginComponent: text("plugin_component"),
  // `"assistant"`: the workspace's Assistant (`agents/builtin.ts`), one per owner. No input sets it.
  builtIn: text("built_in").$type<"assistant">(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("agents_one_assistant_idx").on(t.ownerId).where(sql`${t.builtIn} = 'assistant'`)]);

// Workflows: the trigger and steps live in versions; a run keeps the version it started on.
export const workflows = pgTable("workflows", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  currentVersion: integer("current_version").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    def: jsonb("def").$type<WorkflowDef>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workflowId, t.version] })],
);

export type RunSource = "workflow" | "agent";
export type RunStatus = "running" | "waiting" | "succeeded" | "failed";
/** What started a run: the owner, or a schedule's fire for `scheduledFor` (ISO 8601, UTC). */
export type RunTrigger =
  | { type: "manual" }
  | { type: "schedule"; scheduledFor: string }
  /** A primitive trigger's event, with what the trigger node gives the Job: the change. */
  | { type: "event"; eventId: string; outputs: Record<string, string> }
  /** A poll trigger's new item, with the action that found it and what the trigger node gives the Job: the item. */
  | { type: "poll"; triggerId: string; itemId: string; toolId: string; action: string; outputs: Record<string, string> }
  /** Another Job's consult (`engine/consults.ts`): its question row, and what the trigger node gives the Job (the question, who asks). */
  | { type: "consult"; questionId: string; outputs: Record<string, string> };
export type StepStatus = "pending" | "running" | "waiting" | "succeeded" | "failed" | "skipped";

/** Who waits on a queued step, served in this order (`engine/slots.ts`): a person, a resume, a new start. */
export type QueueClass = "person" | "resume" | "new";
/**
 * What a step does once it holds a slot: its session's start, the answers and chat messages that
 * wait for it (`deliver`), or its lost session's resume, which carries those too.
 */
export type PendingAction = { kind: "start" | "deliver" | "resume" };

/** The agent as it was when its Job was created: the Job's sessions read it, not the `agents` row. */
export type AgentSnapshot = {
  id: string;
  name: string;
  harnessId: string;
  systemPrompt: string;
  model?: string;
  skills: { packageId: string; name: string }[];
  tools: { toolId: string; name: string }[];
  /** Absent in Jobs created before bundles existed: none, on all tables. */
  bundles?: Bundle[];
  tables?: TableScope;
  /** The agents it may consult (`agent_consults`); absent in Jobs created before consults existed: none. */
  consults?: { agentId: string; ask: boolean }[];
};
/** What made a Job, and how many Jobs deep its chain is (0 for a user or a schedule): information only, never a limit. */
export type JobCause = (
  | { kind: "user" }
  | { kind: "schedule"; scheduledFor: string }
  /** `jobId`: the Job whose write it was; `rootJobId`: the first Job of the chain (Jobs made before roots were counted). */
  | { kind: "event"; eventId: string; jobId?: string; rootJobId?: string }
  /** A poll's new item: always the root of its chain. */
  | { kind: "poll"; triggerId: string; itemId: string }
  /** A consult: the asking Job's question row, and that Job. */
  | { kind: "consult"; questionId: string; jobId: string }
) & { depth: number };

export type RootKind = "user" | "chat" | "schedule" | "event" | "poll";
export type RootState = "going" | "paused" | "stopped";

/**
 * A root cause (design 6.1): a person's start or write, a chat message, a schedule fire, a poll
 * item. Every Job it leads to counts here (`Engine.createJob`, with the row locked), and each
 * time `jobs - counted_from` reaches the workspace's checkpoint the root pauses and asks a
 * person: approved, it goes on (`counted_from` moves up); "don't ask again" (`dont_ask`) ends its
 * checkpoints; declined, it stops for good.
 */
export const roots = pgTable(
  "roots",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").$type<RootKind>().notNull(),
    // The run it started from: a chat's run, or its first Job. Its Approval is asked on it.
    runId: text("run_id"),
    jobs: integer("jobs").notNull().default(0),
    // The Jobs counted when it last went on: the next checkpoint is `checkpoint` Jobs further.
    countedFrom: integer("counted_from").notNull().default(0),
    state: text("state").$type<RootState>().notNull().default("going"),
    dontAsk: boolean("dont_ask").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("roots_paused_idx").on(t.ownerId).where(sql`${t.state} = 'paused'`)],
);

/** The workspace's settings, one row per owner (none: the defaults). */
export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    ownerId: text("owner_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    // How many Jobs of one root cause go before a person is asked (design 6.1).
    checkpoint: integer("checkpoint").notNull().default(100),
    // How many days Audit rows are kept (design 6.8).
    auditRetentionDays: integer("audit_retention_days").notNull().default(90),
  },
  (t) => [
    check("workspace_settings_checkpoint_range", sql`${t.checkpoint} between 1 and 100000`),
    check("workspace_settings_audit_retention_range", sql`${t.auditRetentionDays} between 1 and 3650`),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // A workflow run has its workflow and version; a Job (`source: "agent"`) has its agent, its
    // trigger and its own definition.
    source: text("source").$type<RunSource>().notNull().default("workflow"),
    workflowId: text("workflow_id").references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    triggerId: text("trigger_id").references((): AnyPgColumn => triggers.id, { onDelete: "set null" }),
    def: jsonb("def").$type<WorkflowDef>(),
    snapshot: jsonb("snapshot").$type<AgentSnapshot>(),
    cause: jsonb("cause").$type<JobCause>(),
    // A Job's root cause (`roots`); a chat's moves to each message of the owner. Null for a workflow run.
    rootId: text("root_id").references(() => roots.id),
    // A Job's token for the Job endpoint (`platform/token.ts`): its hash and its sealed form, never the token.
    tokenHash: text("token_hash").unique(),
    tokenSealed: text("token_sealed"),
    status: text("status").$type<RunStatus>().notNull(),
    trigger: jsonb("trigger").$type<RunTrigger>().notNull().default({ type: "manual" }),
    error: text("error"),
    // The trace the run was created in (a scheduler tick, a request): to find its telemetry.
    traceId: text("trace_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    index("runs_workflow_idx").on(t.workflowId, t.createdAt),
    index("runs_agent_idx").on(t.agentId, t.createdAt),
    index("runs_status_idx").on(t.status),
    index("runs_root_idx").on(t.rootId),
  ],
);

export type ScheduleFireStatus = "started" | "skipped-overlap" | "refused";
export type TriggerKind = "manual" | "schedule" | "primitive" | "poll";
export type TriggerConcurrency = "parallel" | "one-at-a-time";

/**
 * A poll's walk under way: `{{lastPoll}}` as it was when the walk began (every page runs that one
 * query), when it began (its items' `first_seen`), and the server's token for the next page (null:
 * the walk starts over from its first page, its continuation changed).
 */
export type PollCursor = { lastPoll: string; startedAt: string; token: string | null };

/** What makes an agent work: each firing creates a Job. A schedule's next fire is claimed by the scheduler. */
export const triggers = pgTable(
  "triggers",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").$type<TriggerKind>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    name: text("name").notNull(),
    // Added to the Job's prompt for this trigger.
    instructions: text("instructions").notNull().default(""),
    concurrency: text("concurrency").$type<TriggerConcurrency>().notNull().default("parallel"),
    // A primitive or poll trigger's most Jobs in an hour; an event or item past it waits (deferred).
    rateCap: integer("rate_cap").notNull().default(60),
    config: jsonb("config").$type<TriggerConfig>().notNull(),
    // Set for schedules, with the meaning they have on `schedules`. For a poll: when the next poll
    // is due, and when its baseline was recorded (null: the next poll is its baseline).
    nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    // A poll walking its tool's continuation: where the walk is (null between walks).
    pollCursor: jsonb("poll_cursor").$type<PollCursor>(),
    // `"review"`: the Assistant's scheduled review of the workspace (`agents/builtin.ts`), one per agent. No input sets it.
    builtIn: text("built_in").$type<"review">(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("triggers_agent_idx").on(t.agentId),
    index("triggers_due_idx").on(t.nextFireAt).where(sql`${t.enabled}`),
    uniqueIndex("triggers_one_review_idx").on(t.agentId).where(sql`${t.builtIn} = 'review'`),
  ],
);

/** One due time of a schedule trigger, once, like `schedule_fires` for workflows. */
export const triggerFires = pgTable(
  "trigger_fires",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    triggerId: text("trigger_id")
      .notNull()
      .references(() => triggers.id, { onDelete: "cascade" }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    status: text("status").$type<ScheduleFireStatus>().notNull(),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    message: text("message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.triggerId, t.scheduledFor)],
);

/** A schedule-triggered workflow's next fire; the scheduler claims due rows. */
export const schedules = pgTable(
  "schedules",
  {
    workflowId: text("workflow_id")
      .primaryKey()
      .references(() => workflows.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextFireAt: timestamp("next_fire_at", { withTimezone: true }).notNull(),
    // Fires after this were not looked at yet: a catch-up fires once for the latest in (last_checked_at, now].
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("schedules_due_idx").on(t.nextFireAt)],
);

/** One due time of a schedule, once: what it did (the unique key keeps a time from firing twice). */
export const scheduleFires = pgTable(
  "schedule_fires",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    status: text("status").$type<ScheduleFireStatus>().notNull(),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    message: text("message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.workflowId, t.scheduledFor)],
);

/** One node of a run: the trigger or a step. A node with a session has one harness session. */
export const stepRuns = pgTable(
  "step_runs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    // Which pass of a loop's body this row is (0 outside loops).
    iteration: integer("iteration").notNull().default(0),
    status: text("status").$type<StepStatus>().notNull(),
    sessionId: text("session_id").unique(),
    // The harness as it was when the session started, so an edit doesn't move a running session.
    harness: jsonb("harness").$type<Harness>(),
    runnerId: text("runner_id"),
    // What the session was started with; resent with the CLI session id to resume it.
    start: jsonb("start").$type<StartParams>(),
    // When the hub wrote the start (or the last resume) to the runner; null: never written.
    startDeliveredAt: timestamp("start_delivered_at"),
    // When the session last reported something (any event but an error): proof its start arrived.
    lastActivityAt: timestamp("last_activity_at"),
    cliSessionId: text("cli_session_id"),
    // Highest runner seq handled for this session: replays (at-least-once delivery) are dropped.
    eventSeq: bigint("event_seq", { mode: "number" }).notNull().default(0),
    outputs: jsonb("outputs").$type<Record<string, string>>(),
    error: text("error"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    // An agent step's harness, whose slots it takes (`engine/slots.ts`); null for the other steps.
    harnessId: text("harness_id").references(() => harnesses.id, { onDelete: "set null" }),
    // Holds one of its harness's slots: its session works on a turn, or is about to start.
    working: boolean("working").notNull().default(false),
    // Waiting for a slot since then, served by class, then oldest first; null when not queued.
    queuedAt: timestamp("queued_at"),
    queueClass: text("queue_class").$type<QueueClass>(),
    // What it does once it holds a slot: set when queued (or handed one), cleared when done;
    // `recover()` replays it for a step handed a slot before the process stopped.
    pendingAction: jsonb("pending_action").$type<PendingAction>(),
  },
  (t) => [
    unique().on(t.runId, t.nodeId, t.iteration),
    index("step_runs_queued_idx").on(t.harnessId, t.queuedAt).where(sql`${t.queuedAt} is not null`),
    index("step_runs_working_idx").on(t.harnessId).where(sql`${t.working}`),
  ],
);

/** Chat transcripts and step transcripts: assistant text (deltas appended), user messages, tool calls. */
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    position: integer("position").generatedAlwaysAsIdentity(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepRunId: text("step_run_id")
      .notNull()
      .references(() => stepRuns.id, { onDelete: "cascade" }),
    role: text("role").$type<"assistant" | "user" | "tool">().notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // User messages: when the hub wrote them to the runner (null: resent on recovery).
    deliveredAt: timestamp("delivered_at"),
  },
  (t) => [index("messages_step_idx").on(t.stepRunId, t.position), index("messages_run_idx").on(t.runId, t.position)],
);

/**
 * Cloud sessions (`cloud/runner.ts`): Dispand runs their tool loop itself, so their history is
 * here. One row per session (`id` is the step run's session id).
 */
export const cloudSessions = pgTable("cloud_sessions", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  stepRunId: text("step_run_id")
    .notNull()
    .references(() => stepRuns.id, { onDelete: "cascade" }),
  harnessId: text("harness_id").notNull(),
  // The agent's model, when it overrides the harness's.
  model: text("model"),
  start: jsonb("start").$type<StartParams>().notNull(),
  // The conversation as the model sees it, append-only (assistant items keep the provider's raw content).
  items: jsonb("items").$type<ChatItem[]>().notNull().default([]),
  // running: the loop works on it; waiting: on the owner's answer to `pending`; idle: a chat's turn ended; done.
  status: text("status").$type<"running" | "waiting" | "idle" | "done">().notNull(),
  // Chat messages that arrived during a turn: they join the history before the next model call.
  queued: jsonb("queued").$type<string[]>().notNull().default([]),
  // The question the session waits on, for the tool call `callId` of the last assistant item.
  // `key`: the tool a permission question is about, so its answer stays with that tool.
  pending: jsonb("pending").$type<{ questionId: string; callId: string; payload: QuestionPayload; key?: string } | null>(),
  // The tool call the owner allowed once, run next.
  approvedCall: text("approved_call"),
  // The tool that call was approved for: a name that now maps to another tool isn't run.
  approvedKey: text("approved_key"),
  // The tool call running now: a restart doesn't run it again.
  inFlight: jsonb("in_flight").$type<{ callId: string; key: string } | null>(),
  // No longer read or written: "always allow" is kept on the agent (`agent_tools.unasked`).
  allowedKeys: jsonb("allowed_keys").$type<string[]>().notNull().default([]),
  reminded: boolean("reminded").notNull().default(false),
  // The last event's seq, and the event, handed to the engine again on boot (it drops it if handled).
  seq: bigint("seq", { mode: "number" }).notNull().default(0),
  lastEvent: jsonb("last_event").$type<HarnessEvent>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type QuestionStatus = "pending" | "answered" | "expired";

/** `consult`: a question to another agent, answered by that agent's Job (`engine/consults.ts`), never by a person: not an Inbox item. */
export type QuestionKind = "question" | "approval" | "consult";
/** One write of a proposal: a platform tool and its input as the tool parsed it; `usedAt` once the Job made that call. */
/**
 * `input` may hold `{ "$item": n }`: what item `n` created (`createdId`). A used item is
 * `pending` while its call runs, and `failed` once the call was refused.
 */
export type ProposalItem = { tool: string; input: unknown; usedAt?: string; pending?: true; createdId?: string; failed?: true };

/**
 * Proposals (`platform/proposals.ts`): the writes a Job's agent asks a person to approve
 * before it makes them, for what changes what agents may do. `draft` until the agent asks for
 * it (`asked`, with its question), then `approved` or `declined` by the owner's answer. It
 * belongs to its Job: no other run uses its items.
 */
export const proposals = pgTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    items: jsonb("items").$type<ProposalItem[]>().notNull(),
    /** The business name of the generated plugin that records what its items create, if any. */
    plugin: text("plugin"),
    status: text("status").$type<"draft" | "asked" | "approved" | "declined">().notNull().default("draft"),
    // The Approval it was asked with.
    questionId: text("question_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    settledAt: timestamp("settled_at"),
  },
  (t) => [index("proposals_run_idx").on(t.runId)],
);

/**
 * Who answered a question: a person, or an agent's Job with the `inbox` bundle (under the name
 * the agent had then, as the asking Job is told it).
 */
export type AnsweredBy = { type: "user"; userId: string } | { type: "agent"; agentId: string; runId: string; name: string };

export const questions = pgTable(
  "questions",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    // A checkpoint's Approval has no session (and, outside a chat, no step).
    stepRunId: text("step_run_id").references(() => stepRuns.id, { onDelete: "cascade" }),
    sessionId: text("session_id"),
    // The id the runner gave it, sent back with the answer.
    runnerQuestionId: text("runner_question_id"),
    placement: text("placement").$type<"chat" | "notifications">().notNull(),
    // An approval authorizes an action (a permission); a question asks for words or a choice.
    kind: text("kind").$type<QuestionKind>().notNull().default("question"),
    payload: jsonb("payload").$type<QuestionPayload>().notNull(),
    status: text("status").$type<QuestionStatus>().notNull(),
    answer: jsonb("answer").$type<Answer>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    answeredAt: timestamp("answered_at"),
    // Who answered; null for answers given before this was recorded.
    answeredBy: jsonb("answered_by").$type<AnsweredBy>(),
    // For a permission about one of a Job's exposed tools: the tool and action it is for, in full.
    about: jsonb("about").$type<{ tool: string; action: string; description: string }>(),
    // The proposal this Approval is for (`platform/proposals.ts`): what the owner approves is its items, not the agent's words.
    proposalId: text("proposal_id"),
    // When a server-side call used this approval up (`platform/approvals.ts`): one approval, one call.
    consumedAt: timestamp("consumed_at"),
    // When the answer reached the session (null while answered: resent when the runner is back).
    deliveredAt: timestamp("delivered_at"),
    // Asked by a session the runner lost and resumed since: its answer goes as a chat message.
    orphaned: boolean("orphaned").notNull().default(false),
    // A checkpoint's Approval (design 6.1): the root cause it pauses. No session waits on it.
    rootId: text("root_id").references(() => roots.id, { onDelete: "cascade" }),
    // A consult: the consulted Job, once made (null while its root is paused, or when it was refused).
    consultRunId: text("consult_run_id").references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
    // An Approval of a flagged consult: the consult row it is for (`engine/consults.ts`). No session waits on it, its consult does.
    consultId: text("consult_id").references((): AnyPgColumn => questions.id, { onDelete: "cascade" }),
  },
  (t) => [
    unique().on(t.sessionId, t.runnerQuestionId),
    index("questions_run_idx").on(t.runId),
    index("questions_consult_run_idx").on(t.consultRunId),
    index("questions_consult_idx").on(t.consultId),
    uniqueIndex("questions_checkpoint_idx").on(t.rootId).where(sql`${t.status} = 'pending'`),
  ],
);

// Dashboards: the home page (one per owner, fixed) and its widgets.
export const pages = pgTable(
  "pages",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"home" | "page">().notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pages_one_home_idx").on(t.ownerId).where(sql`${t.kind} = 'home'`)],
);

export const widgets = pgTable(
  "widgets",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    type: text("type").$type<"workflow-form" | "trigger-form" | "grid" | "table">().notNull(),
    title: text("title").notNull(),
    // A workflow form has a workflow; a trigger form an agent's manual trigger; a Grid or Table
    // widget a table and its config.
    workflowId: text("workflow_id").references(() => workflows.id, { onDelete: "cascade" }),
    triggerId: text("trigger_id").references(() => triggers.id, { onDelete: "cascade" }),
    tableId: text("table_id").references(() => tables.id, { onDelete: "cascade" }),
    config: jsonb("config").$type<WidgetConfig>(),
    layout: jsonb("layout").$type<WidgetLayout>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  // Not unique: widgets made before creation became idempotent keep their own titles and layouts.
  (t) => [
    index("widgets_page_idx").on(t.pageId),
    index("widgets_page_workflow_idx").on(t.pageId, t.workflowId),
    index("widgets_trigger_idx").on(t.triggerId),
    index("widgets_table_idx").on(t.tableId),
    check(
      "widgets_target_check",
      sql`(${t.type} = 'workflow-form' and ${t.workflowId} is not null and ${t.triggerId} is null and ${t.tableId} is null and ${t.config} is null) or (${t.type} = 'trigger-form' and ${t.triggerId} is not null and ${t.workflowId} is null and ${t.tableId} is null and ${t.config} is null) or (${t.type} in ('grid', 'table') and ${t.workflowId} is null and ${t.triggerId} is null and ${t.tableId} is not null and ${t.config} is not null)`,
    ),
  ],
);

// Data: an owner's tables. A row's values are one object keyed by field id, so renaming a field
// touches no row. Names are unique case-insensitively: per owner (tables), per table (fields).
export const tables = pgTable(
  "tables",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // A primitive table records each write of its rows as an event (node C).
    primitive: boolean("primitive").notNull().default(false),
    // A primitive table's parent: its reference field that names the parent table's rows, and
    // whether every row must name one. The field can't be deleted or retyped while it is the parent.
    parentFieldId: text("parent_field_id").references((): AnyPgColumn => fields.id, { onDelete: "set null" }),
    parentRequired: boolean("parent_required").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tables_owner_name_idx").on(t.ownerId, sql`lower(${t.name})`)],
);

/** Who made a write: a person, a Job (its run), or a workflow's step. */
export type EventActor = { type: "user"; userId: string } | { type: "job"; runId: string } | { type: "step"; runId: string; stepId: string };

/** A row's write; for the built-in `interaction` kind, a Question or an Approval asked, answered or expired. */
export type EventOperation = "created" | "updated" | "deleted" | "answered" | "expired";

/**
 * The outbox (node C): one row per write of a row of a primitive table, appended in the same
 * transaction as the write; and one per Question or Approval asked, answered or expired, with the
 * built-in kind `interaction` as its table (`engine/interactions.ts`). `before` and `after` hold
 * the changed fields' values (every field of a deleted row). The scheduler marks each one processed once its triggers had their chance.
 * Kept after processing: it is also the record of data changes.
 */
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tableId: text("table_id").notNull(),
    rowId: text("row_id").notNull(),
    operation: text("operation").$type<EventOperation>().notNull(),
    changedFieldIds: jsonb("changed_field_ids").$type<string[]>().notNull(),
    before: jsonb("before").$type<Record<string, Cell>>().notNull(),
    after: jsonb("after").$type<Record<string, Cell>>().notNull(),
    actor: jsonb("actor").$type<EventActor>().notNull(),
    // The root cause of the Job that wrote it, as it was then; null: the write is a root of its own.
    rootId: text("root_id").references(() => roots.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    processedAt: timestamp("processed_at"),
  },
  (t) => [index("events_unprocessed_idx").on(t.createdAt).where(sql`${t.processedAt} is null`), index("events_table_row_idx").on(t.tableId, t.rowId)],
);

export type EventFireStatus = "started" | "deferred" | "skipped-same-agent" | "out-of-scope" | "refused" | "stopped";

/**
 * What one event did for one primitive trigger, once (the unique key). A deferred fire (past the
 * rate cap, or one at a time with a Job going) is tried again each tick until it starts, or its
 * root cause is declined at a checkpoint (`stopped`).
 */
export const eventFires = pgTable(
  "event_fires",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    triggerId: text("trigger_id")
      .notNull()
      .references(() => triggers.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    status: text("status").$type<EventFireStatus>().notNull(),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    message: text("message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // When its Job was created: what the rate cap counts.
    startedAt: timestamp("started_at", { withTimezone: true }),
  },
  (t) => [
    unique().on(t.triggerId, t.eventId),
    index("event_fires_deferred_idx").on(t.createdAt).where(sql`${t.status} = 'deferred'`),
    index("event_fires_started_idx").on(t.triggerId, t.startedAt),
  ],
);

export type PollStatus = "calling" | "baseline" | "polled" | "skipped" | "failed";

/**
 * One poll of a poll trigger: claimed (`calling`, its call under way or cut short), then what it
 * came to. `baseline`: the first poll since the trigger was made, changed or turned on, which
 * records what exists and starts nothing. A trigger keeps its latest `MAX_POLLS_KEPT`.
 */
export const polls = pgTable(
  "polls",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    triggerId: text("trigger_id")
      .notNull()
      .references(() => triggers.id, { onDelete: "cascade" }),
    // When it was claimed, before its call: what its new items' `first_seen` is.
    at: timestamp("at", { withTimezone: true }).notNull(),
    status: text("status").$type<PollStatus>().notNull(),
    // Items the call returned, and how many of them were new.
    found: integer("found").notNull().default(0),
    fresh: integer("fresh").notNull().default(0),
    message: text("message"),
  },
  (t) => [index("polls_trigger_idx").on(t.triggerId, t.at)],
);

export type PollItemStatus = "baseline" | "started" | "deferred" | "out-of-scope" | "refused";

/**
 * Each item a poll trigger has seen, once (the unique key), with its content (what its Job is
 * told). A deferred item (past the rate cap, or one at a time with a Job going) is tried again
 * each tick from this row, whatever later polls return.
 */
export const pollItems = pgTable(
  "poll_items",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    triggerId: text("trigger_id")
      .notNull()
      .references(() => triggers.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    // The item as JSON.
    content: text("content").notNull(),
    // The poll that found it: its claim's time (`{{lastPoll}}` is the newest of these).
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull(),
    status: text("status").$type<PollItemStatus>().notNull(),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    message: text("message"),
    // When its Job was created: what the rate cap counts.
    startedAt: timestamp("started_at", { withTimezone: true }),
  },
  (t) => [
    unique().on(t.triggerId, t.itemId),
    index("poll_items_deferred_idx").on(t.firstSeen).where(sql`${t.status} = 'deferred'`),
    index("poll_items_started_idx").on(t.triggerId, t.startedAt),
    index("poll_items_seen_idx").on(t.triggerId, t.firstSeen),
  ],
);

export const fields = pgTable(
  "fields",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tableId: text("table_id")
      .notNull()
      .references(() => tables.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").$type<FieldType>().notNull(),
    choices: jsonb("choices").$type<Choice[]>().notNull().default([]),
    // A reference field: the table whose rows it names. A table something points at can't be
    // deleted (`tables.delete` refuses): no cascade.
    referencesTableId: text("references_table_id").references((): AnyPgColumn => tables.id),
    /** 0 is the primary field. */
    position: integer("position").notNull(),
  },
  (t) => [uniqueIndex("fields_table_name_idx").on(t.tableId, sql`lower(${t.name})`)],
);

export const rows = pgTable(
  "rows",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tableId: text("table_id")
      .notNull()
      .references(() => tables.id, { onDelete: "cascade" }),
    values: jsonb("values").$type<Record<string, Cell>>().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("rows_table_idx").on(t.tableId, t.createdAt, t.id)],
);

// Files uploaded to a table's attachment cells. The file itself is `<filesDir>/<ownerId>/<id>`
// on the app's volume: nothing in its path comes from the upload.
export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The table it was uploaded to or written in; none while it is only a Job's (a file a tool returned). */
    tableId: text("table_id").references(() => tables.id, { onDelete: "cascade" }),
    /** The Job a tool returned it to: until a row of it is written, the file is only that Job's. */
    jobId: text("job_id").references(() => runs.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** The sniffed image type, else `application/octet-stream`. */
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    /** A sniffed PNG, JPEG, GIF or WebP: the only files served inline. */
    image: boolean("image").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("attachments_table_idx").on(t.tableId), index("attachments_job_idx").on(t.jobId)],
);

// Plugin marketplaces: Git repositories with a `.claude-plugin/marketplace.json`, read at each
// sync. The built-in ones are seeded with the owner and can't be removed.
export const marketplaces = pgTable(
  "marketplaces",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The marketplace's own name, from its last sync. */
    name: text("name").notNull(),
    url: text("url").notNull(),
    kind: text("kind").$type<MarketplaceKind>().notNull().default("marketplace"),
    builtIn: boolean("built_in").notNull().default(false),
    entries: jsonb("entries").$type<MarketplaceEntry[]>().notNull().default([]),
    syncedAt: timestamp("synced_at"),
    /** Why the last sync failed; the entries are then the previous sync's. */
    syncError: text("sync_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique("marketplaces_owner_url").on(t.ownerId, t.url)],
);

/** What a generated plugin lists, by kind: the ids its proposals' items created. */
export type PluginCreated = Partial<Record<"table" | "field" | "agent" | "trigger" | "tool", string[]>>;

// Installed plugins: an entry of a marketplace, read at commit `sha`. What it brings (a skill
// package, tools, agents) references it and goes with it. A `generated` one ("Generated: <business
// name>") records what approved proposals naming it created (`created`) and owns nothing: no row
// references it, so removing it removes the record only.
export const plugins = pgTable(
  "plugins",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    source: text("source").$type<"marketplace" | "generated">().notNull().default("marketplace"),
    /** A marketplace plugin's entry; null for a generated one, as are `url` and `sha`. */
    marketplaceId: text("marketplace_id").references(() => marketplaces.id),
    entryName: text("entry_name"),
    /** The Git repository it was read from, at `sha`. */
    url: text("url"),
    sha: text("sha"),
    /** Everything the plugin offered when last read, imported or not. */
    components: jsonb("components").$type<PluginComponents>().notNull(),
    notImported: jsonb("not_imported").$type<NotImported[]>().notNull().default([]),
    created: jsonb("created").$type<PluginCreated>().notNull().default({}),
    installedAt: timestamp("installed_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("plugins_owner_entry").on(t.ownerId, t.marketplaceId, t.entryName),
    uniqueIndex("plugins_owner_generated_idx").on(t.ownerId, t.name).where(sql`${t.source} = 'generated'`),
  ],
);

/**
 * Tools: MCP servers agents and Tool steps call (`tools/`). `http` tools are called by URL from
 * the server (and by the CLIs), with headers sealed one by one (`headerAad(id, name)`);
 * `runner` tools add their own columns. Names are unique case-insensitively per owner.
 */
export const tools = pgTable(
  "tools",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // `http`: Dispand reaches it at `url`. `runner`: a runner runs it, the MCP server named
    // `runnerTool` in that runner's own config; Dispand never knows its command.
    kind: text("kind").$type<"http" | "runner">().notNull(),
    // With `urlSealed`, the URL's template (with its `${VAR}` placeholders), shown in place of it. Null for a runner tool.
    url: text("url"),
    // A URL holding secrets (a plugin server's `${VAR}` filled in), sealed with them as JSON
    // `{ url, secrets }` (`urlAad(id)`). Added with 0023: every row is written by `insertTool`
    // under its rules (secrets only in the path or query), so none holds a secret in its host.
    urlSealed: text("url_sealed"),
    transport: text("transport").$type<ToolTransport>(),
    // Header name (lower case) → sealed value. Never leaves the server; views list the names.
    headersSealed: jsonb("headers_sealed").$type<Record<string, string>>().notNull().default({}),
    // From the last listing that succeeded; `actionsError` says why the last one failed.
    actions: jsonb("actions").$type<ToolAction[]>().notNull().default([]),
    actionsError: text("actions_error"),
    // The actions a poll may read, set by the owner; null: the ones the server marks read-only.
    // An action some agent must ask before using is never polled, whatever this says (`tools/pollable.ts`).
    pollable: jsonb("pollable").$type<string[]>(),
    refreshedAt: timestamp("refreshed_at"),
    // The catalog entry it was installed from (`tools/catalog.ts`), if any.
    catalogId: text("catalog_id"),
    // The plugin it came from, and its MCP server's name there; it goes with the plugin.
    pluginId: text("plugin_id").references((): AnyPgColumn => plugins.id, { onDelete: "cascade" }),
    pluginComponent: text("plugin_component"),
    // A runner tool's runner, and the server's name in its config (one the runner reported in `hello`).
    runnerId: text("runner_id").references(() => runners.id),
    runnerTool: text("runner_tool"),
    // How an HTTP tool signs in: nothing, its sealed headers, or OAuth (`tools/oauth.ts`; no headers then).
    auth: text("auth").$type<ToolAuth>().notNull().default("none"),
    // OAuth only. The sealed state (`oauthAad(id)`): client information and tokens per issuer,
    // discovery, the owner's entered client, and a flow under way with its verifier. Never leaves the server.
    oauthSealed: text("oauth_sealed"),
    // `authorize` (never connected), `connected`, or `reauthorize` (its grant stopped working): shown without opening the seal.
    oauthStatus: text("oauth_status").$type<OAuthStatus>(),
    // SHA-256 of the `state` of the flow under way, which the callback finds the tool by.
    oauthStateHash: text("oauth_state_hash"),
    // The client id the owner entered (not a secret; its secret is sealed in `oauthSealed`).
    oauthClientId: text("oauth_client_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tools_owner_name_idx").on(t.ownerId, sql`lower(${t.name})`), index("tools_oauth_state_idx").on(t.oauthStateHash)],
);

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });

// Skill packages: one or more skills (a folder each, with its `SKILL.md`) and their files. A
// user-made package holds one skill named like it; a plugin's (`plugin_id`, set by plugin installs)
// holds the plugin's skills and is read-only, like the built-in one (`built_in`, one per owner:
// the platform skill, written from the build's files by `syncPlatformSkill`). Every file path
// passes `isSafeRelativePath`.
export const skillPackages = pgTable(
  "skill_packages",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    pluginId: text("plugin_id").references((): AnyPgColumn => plugins.id, { onDelete: "cascade" }),
    /** Tools an agent gets, locked, with this package. */
    requiredToolIds: jsonb("required_tool_ids").$type<string[]>().notNull().default([]),
    builtIn: boolean("built_in").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("skill_packages_owner_name").on(t.ownerId, t.name), uniqueIndex("skill_packages_one_built_in_idx").on(t.ownerId).where(sql`${t.builtIn}`)],
);

export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id")
      .notNull()
      .references(() => skillPackages.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
  },
  (t) => [unique("skills_package_name").on(t.packageId, t.name)],
);

export const skillFiles = pgTable(
  "skill_files",
  {
    packageId: text("package_id")
      .notNull()
      .references(() => skillPackages.id, { onDelete: "cascade" }),
    /** `<skill>/<path inside the skill>`. */
    path: text("path").notNull(),
    content: bytea("content").notNull(),
  },
  (t) => [primaryKey({ columns: [t.packageId, t.path] })],
);

/**
 * The skill packages and tools chosen for an agent. `agent_tools` holds the explicit tools only:
 * the ones its packages require come with them (`agents/tools.ts`). A package or tool an agent
 * uses can't be deleted (no cascade): its procedure says which agent holds it.
 */
export const agentSkills = pgTable(
  "agent_skills",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    packageId: text("package_id")
      .notNull()
      .references(() => skillPackages.id),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.packageId] }), index("agent_skills_package_idx").on(t.packageId)],
);

/**
 * The agents an agent may consult (`agents/consults.ts`). Naming one is a grant: a person on the
 * agent's page, or an approved proposal. `ask`: each consult asks the owner first.
 */
export const agentConsults = pgTable(
  "agent_consults",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    consultedId: text("consulted_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    ask: boolean("ask").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.consultedId] }), index("agent_consults_consulted_idx").on(t.consultedId)],
);

export const agentTools = pgTable(
  "agent_tools",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolId: text("tool_id")
      .notNull()
      .references(() => tools.id),
    // The tool's actions that run without asking the owner, for this agent; every other one
    // asks before use. Filled from the actions' read-only hints when a person adds the tool,
    // then changed by a person only: taking an action off the asking ones is a grant.
    unasked: jsonb("unasked").$type<string[]>().notNull().default([]),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.toolId] }), index("agent_tools_tool_idx").on(t.toolId)],
);

/**
 * Audit (design 6.8): one row per thing an agent's work did or met, written only by
 * `audit/record.ts`. A row names what was touched (ids, names, counts, kinds), never its content.
 * `job_id` has no foreign key: a row outlives its Job.
 */
export const audit = pgTable(
  "audit",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actor: jsonb("actor").$type<AuditActor>().notNull(),
    // The acting Job's agent, or the agent a scheduler row is for: what the agent filter reads.
    actorAgentId: text("actor_agent_id"),
    jobId: text("job_id"),
    action: text("action").$type<AuditAction>().notNull(),
    resourceType: text("resource_type").$type<AuditResource>().notNull(),
    resourceId: text("resource_id"),
    result: text("result").$type<AuditResult>().notNull(),
    details: jsonb("details").$type<AuditDetails>().notNull(),
    traceId: text("trace_id"),
  },
  (t) => [
    index("audit_owner_at_idx").on(t.ownerId, t.at.desc(), t.id.desc()),
    index("audit_owner_job_idx").on(t.ownerId, t.jobId, t.at),
    index("audit_owner_action_idx").on(t.ownerId, t.action, t.at),
    index("audit_at_idx").on(t.at),
  ],
);
