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
import type { ToolAction, ToolTransport } from "../tools/mcp.ts";

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
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
  // Overrides the harness's model when set.
  model: text("model"),
  // What its Jobs may do through Dispand's own tools, and on which tables (`platform/`).
  bundles: jsonb("bundles").$type<Bundle[]>().notNull().default([]),
  dataTables: jsonb("data_tables").$type<TableScope>().notNull().default(sql`'"all"'::jsonb`),
  // The plugin it came from, and its name there (`plugins/`); it goes with the plugin.
  pluginId: text("plugin_id").references((): AnyPgColumn => plugins.id, { onDelete: "cascade" }),
  pluginComponent: text("plugin_component"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
export type RunTrigger = { type: "manual" } | { type: "schedule"; scheduledFor: string };
export type StepStatus = "pending" | "running" | "waiting" | "succeeded" | "failed" | "skipped";

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
};
/** What made a Job, and how many Jobs deep its chain is (0 for a user or a schedule). */
export type JobCause = (
  | { kind: "user" }
  | { kind: "schedule"; scheduledFor: string }
  | { kind: "event"; eventId: string; jobId?: string }
  | { kind: "poll"; triggerId: string; itemId: string }
) & { depth: number };

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
    // A Job's token for the Job endpoint (`platform/token.ts`): its hash and its sealed form, never the token.
    tokenHash: text("token_hash").unique(),
    tokenSealed: text("token_sealed"),
    status: text("status").$type<RunStatus>().notNull(),
    trigger: jsonb("trigger").$type<RunTrigger>().notNull().default({ type: "manual" }),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    index("runs_workflow_idx").on(t.workflowId, t.createdAt),
    index("runs_agent_idx").on(t.agentId, t.createdAt),
    index("runs_status_idx").on(t.status),
  ],
);

export type ScheduleFireStatus = "started" | "skipped-overlap" | "refused";
export type TriggerKind = "manual" | "schedule";
export type TriggerConcurrency = "parallel" | "one-at-a-time";

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
    config: jsonb("config").$type<TriggerConfig>().notNull(),
    // Set for schedules only, with the meaning they have on `schedules`.
    nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("triggers_agent_idx").on(t.agentId),
    index("triggers_due_idx").on(t.nextFireAt).where(sql`${t.enabled}`),
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
  },
  (t) => [unique().on(t.runId, t.nodeId, t.iteration)],
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
  // Tool keys "Always allow"ed in this session.
  allowedKeys: jsonb("allowed_keys").$type<string[]>().notNull().default([]),
  reminded: boolean("reminded").notNull().default(false),
  // The last event's seq, and the event, handed to the engine again on boot (it drops it if handled).
  seq: bigint("seq", { mode: "number" }).notNull().default(0),
  lastEvent: jsonb("last_event").$type<HarnessEvent>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type QuestionStatus = "pending" | "answered" | "expired";

export type QuestionKind = "question" | "approval";
/** Who answered a question: a person, for now. */
export type AnsweredBy = { type: "user"; userId: string };

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
    stepRunId: text("step_run_id")
      .notNull()
      .references(() => stepRuns.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    // The id the runner gave it, sent back with the answer.
    runnerQuestionId: text("runner_question_id").notNull(),
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
    // When a server-side call used this approval up (`platform/approvals.ts`): one approval, one call.
    consumedAt: timestamp("consumed_at"),
    // When the answer reached the session (null while answered: resent when the runner is back).
    deliveredAt: timestamp("delivered_at"),
    // Asked by a session the runner lost and resumed since: its answer goes as a chat message.
    orphaned: boolean("orphaned").notNull().default(false),
  },
  (t) => [unique().on(t.sessionId, t.runnerQuestionId), index("questions_run_idx").on(t.runId)],
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tables_owner_name_idx").on(t.ownerId, sql`lower(${t.name})`)],
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
    tableId: text("table_id")
      .notNull()
      .references(() => tables.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The sniffed image type, else `application/octet-stream`. */
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    /** A sniffed PNG, JPEG, GIF or WebP: the only files served inline. */
    image: boolean("image").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("attachments_table_idx").on(t.tableId)],
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

// Installed plugins: an entry of a marketplace, read at commit `sha`. What it brings (a skill
// package now; tools and agents later) references it and goes with it.
export const plugins = pgTable(
  "plugins",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    marketplaceId: text("marketplace_id")
      .notNull()
      .references(() => marketplaces.id),
    entryName: text("entry_name").notNull(),
    /** The Git repository it was read from, at `sha`. */
    url: text("url").notNull(),
    sha: text("sha").notNull(),
    /** Everything the plugin offered when last read, imported or not. */
    components: jsonb("components").$type<PluginComponents>().notNull(),
    notImported: jsonb("not_imported").$type<NotImported[]>().notNull().default([]),
    installedAt: timestamp("installed_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("plugins_owner_entry").on(t.ownerId, t.marketplaceId, t.entryName)],
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
    refreshedAt: timestamp("refreshed_at"),
    // The catalog entry it was installed from (`tools/catalog.ts`), if any.
    catalogId: text("catalog_id"),
    // The plugin it came from, and its MCP server's name there; it goes with the plugin.
    pluginId: text("plugin_id").references((): AnyPgColumn => plugins.id, { onDelete: "cascade" }),
    pluginComponent: text("plugin_component"),
    // A runner tool's runner, and the server's name in its config (one the runner reported in `hello`).
    runnerId: text("runner_id").references(() => runners.id),
    runnerTool: text("runner_tool"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tools_owner_name_idx").on(t.ownerId, sql`lower(${t.name})`)],
);

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });

// Skill packages: one or more skills (a folder each, with its `SKILL.md`) and their files. A
// user-made package holds one skill named like it; a plugin's (`plugin_id`, set by plugin installs)
// holds the plugin's skills and is read-only. Every file path passes `isSafeRelativePath`.
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("skill_packages_owner_name").on(t.ownerId, t.name)],
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
