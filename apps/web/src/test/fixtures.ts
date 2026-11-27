import type { Outputs } from "./fake-api.ts";

// Rows as the API answers them, each filled in so a test names only what it checks. A field the
// procedure renames or adds makes these stop compiling.

export const agentRow = (given: Partial<Outputs["agents"]["list"][number]> = {}): Outputs["agents"]["list"][number] => ({
  id: "agent_1",
  ownerId: "user_1",
  name: "Clerk",
  description: "",
  harnessId: "harness_1",
  systemPrompt: "",
  plugin: null,
  overridden: [],
  bundles: [],
  dataTables: [],
  selfLearning: [],
  consultMode: "disabled",
  escalateMode: "disabled",
  preferAgents: false,
  ...given,
});

export const tableRow = (given: Partial<Outputs["tables"]["list"][number]> = {}): Outputs["tables"]["list"][number] => ({
  id: "tbl_1",
  name: "Clients",
  primitive: false,
  plugin: null,
  rowCount: 0,
  updatedAt: new Date("2026-11-12T10:00:00Z"),
  ...given,
});

export const runnerRow = (given: { id?: string; name?: string; tools?: string[] } = {}): Outputs["runners"]["list"][number] => ({
  id: "runner_1",
  name: "Workstation",
  status: "online",
  runnerUpdate: "current",
  lastSeenAt: null,
  clis: {},
  tools: [],
  ...given,
});

type Plugin = Outputs["plugins"]["list"][number];
type PluginRow<Source extends Plugin["source"]> = Extract<Plugin, { source: Source }>;
const pluginParts = {
  id: "plugin_1",
  name: "law-firm",
  description: "",
  updatedAt: new Date("2026-11-12T10:00:00Z"),
  agents: [],
  tables: [],
  fields: [],
  triggers: [],
  definitions: { agents: [], primitives: [], triggers: [] },
  notImported: [],
  nativeBehind: false,
};

export const marketplacePlugin = (given: Partial<PluginRow<"marketplace">> = {}): PluginRow<"marketplace"> => ({
  ...pluginParts,
  source: "marketplace",
  marketplace: "Tools",
  url: null,
  sha: null,
  skills: [],
  tools: [],
  available: { skills: [], mcpServers: [], agents: [] },
  ...given,
});

export const generatedPlugin = (given: Partial<PluginRow<"generated">> = {}): PluginRow<"generated"> => ({
  ...pluginParts,
  source: "generated",
  marketplace: null,
  url: null,
  sha: null,
  skills: [],
  tools: [],
  available: { skills: [], mcpServers: [], agents: [] },
  ...given,
});

type CloudHarness = Extract<Outputs["harnesses"]["list"][number], { type: "cloud" }>;

export const cloudHarness = (given: Partial<CloudHarness> = {}): CloudHarness => ({
  id: "harness_1",
  ownerId: "user_1",
  name: "Claude API",
  type: "cloud",
  kind: "anthropic",
  model: "model-1",
  systemPrompt: "",
  apiKeySet: true,
  ...given,
});

export const rowView = (given: Partial<Outputs["rows"]["list"]["rows"][number]> = {}): Outputs["rows"]["list"]["rows"][number] => ({
  id: "row_1",
  tableId: "tbl_clients",
  values: {},
  createdAt: new Date("2026-11-12T10:00:00Z"),
  updatedAt: new Date("2026-11-12T10:00:00Z"),
  ...given,
});

export const runRow = (given: Partial<Outputs["runs"]["list"][number]> = {}): Outputs["runs"]["list"][number] => ({
  id: "run_1",
  source: "agent",
  workflowId: null,
  workflowName: null,
  version: 0,
  agentId: "agent_1",
  deletedAgentName: null,
  triggerId: null,
  status: "succeeded",
  trigger: { type: "manual" },
  error: null,
  createdAt: new Date("2026-11-12T10:00:00Z"),
  finishedAt: null,
  queued: false,
  title: null,
  waitingOn: null,
  consultedBy: null,
  ...given,
});

export const triggerRow = (given: Partial<Outputs["triggers"]["list"][number]> = {}): Outputs["triggers"]["list"][number] => ({
  id: "trigger_1",
  agentId: "agent_1",
  name: "Morning mail",
  kind: "manual",
  enabled: true,
  instructions: "",
  concurrency: "parallel",
  rateCap: 10,
  config: { kind: "manual", placement: "button" },
  plugin: null,
  overridden: [],
  lastFires: [],
  lastPolls: [],
  lastEvents: [],
  ...given,
});

type CliHarness = Extract<Outputs["harnesses"]["list"][number], { kind: "claude-code" }>;

export const cliHarness = (given: Partial<CliHarness> = {}): CliHarness => ({
  id: "harness_cli",
  ownerId: "user_1",
  name: "Claude Code",
  type: "cli",
  kind: "claude-code",
  permissionMode: "default",
  runnerId: "runner_1",
  ...given,
});

export const questionRow = (given: Partial<Outputs["questions"]["list"][number]> = {}): Outputs["questions"]["list"][number] => ({
  id: "q_1",
  runId: "run_1",
  stepRunId: null,
  placement: "notifications",
  kind: "question",
  status: "pending",
  payload: { kind: "confirm-outputs", values: {} },
  answer: null,
  createdAt: new Date("2026-11-12T10:00:00Z"),
  answeredAt: null,
  answeredBy: null,
  orphaned: false,
  workflow: null,
  agent: null,
  trigger: null,
  run: { id: "run_1" },
  step: { name: "Draft" },
  proposal: null,
  update: null,
  escalation: null,
  consultRunId: null,
  about: null,
  proposalId: null,
  rootId: null,
  ...given,
});

export const attachment = (given: Partial<Outputs["files"]["hold"]> = {}): Outputs["files"]["hold"] => ({
  id: "att_1",
  name: "notes.txt",
  mime: "text/plain",
  size: 2,
  image: false,
  ...given,
});

type Def = Outputs["jobs"]["def"];

/** A graph that starts at a chat, as `jobs.def` and `workflows.get` answer it. */
export const chatDef = (nodeId = "n_chat", agentId = "agent_1"): Def => ({
  trigger: { type: "manual", field: { id: nodeId, key: "chat", type: "chat", label: "Chat", agentId, prompt: "" } },
  steps: [],
  edges: [],
});

/** A graph that starts at a button. */
export const buttonDef = (nodeId = "n_go", label = "Go"): Def => ({
  trigger: { type: "manual", field: { id: nodeId, key: "go", type: "button", label } },
  steps: [],
  edges: [],
});

export const workflowView = (given: Partial<Outputs["workflows"]["get"]> = {}): Outputs["workflows"]["get"] => ({
  id: "wf_1",
  name: "Chat",
  version: 1,
  def: chatDef(),
  updatedAt: new Date("2026-11-12T10:00:00Z"),
  archived: false,
  schedule: null,
  fires: [],
  ...given,
});

export const tableView = (given: Partial<Outputs["tables"]["get"]> = {}): Outputs["tables"]["get"] => ({
  id: "tbl_1",
  name: "Clients",
  primitive: false,
  parent: null,
  fields: [],
  ...given,
});

export const homePage = (given: Partial<Outputs["pages"]["home"]> = {}): Outputs["pages"]["home"] => ({
  id: "page_home",
  ownerId: "user_1",
  kind: "home",
  title: "Home",
  widgets: [],
  ...given,
});

export const toolEntry = (given: Partial<Outputs["agents"]["get"]["tools"][number]> = {}): Outputs["agents"]["get"]["tools"][number] => ({
  toolId: "tool_mail",
  name: "Mail",
  kind: "http",
  explicit: true,
  lockedBy: [],
  ...given,
});

export const pollAction = (given: Partial<Outputs["tools"]["pollable"][number]> = {}): Outputs["tools"]["pollable"][number] => ({
  name: "list_mail",
  readOnly: true,
  allowed: true,
  askedBy: [],
  pollable: true,
  ...given,
});

export const auditRow = (given: Partial<Outputs["audit"]["list"]["rows"][number]> = {}): Outputs["audit"]["list"]["rows"][number] => ({
  id: "aud_1",
  workspaceId: "ws_1",
  ownerId: "user_1",
  at: "2026-11-12T10:00:00.123456Z",
  actor: { type: "job", runId: "run_1" },
  actorAgentId: "agent_1",
  agentName: "Writer",
  agentBuiltIn: null,
  actorName: null,
  byYou: false,
  jobId: "run_1",
  action: "job.started",
  resourceType: "job",
  resourceId: "run_1",
  result: "ok",
  details: { harnessId: "hrn_1", harnessName: "Claude" },
  traceId: "0af7651916cd43dd8448eb211c80319c",
  ...given,
});

export const agentDetail = (given: Partial<Extract<Outputs["agents"]["get"], { consults: unknown }>> = {}): Outputs["agents"]["get"] => ({
  ...agentRow(),
  consults: [],
  escalations: [],
  skills: [],
  tools: [],
  ...given,
});

export const toolRow = (given: Partial<Outputs["tools"]["list"][number]> = {}): Outputs["tools"]["list"][number] => ({
  id: "tool_mail",
  name: "Mail",
  kind: "http",
  url: "https://mail.example.com/mcp",
  urlSet: false,
  transport: "streamable-http",
  headerNames: [],
  overridden: [],
  auth: "none",
  oauthStatus: null,
  enteredClientId: null,
  signIn: "none",
  signInPath: "/settings/tools/tool_mail",
  actions: [],
  disabled: [],
  actionsError: null,
  refreshedAt: null,
  catalogId: null,
  runnerId: null,
  runnerTool: null,
  plugin: null,
  pluginServer: null,
  createdAt: new Date("2026-11-12T10:00:00Z"),
  ...given,
});

const place = { x: 0, y: 0, w: 4, h: 4 };

export const widgetRow = (): Outputs["widgets"]["create"] => ({
  type: "trigger-form",
  triggerId: "trigger_1",
  id: "w1",
  pageId: "page_home",
  title: "Mail",
  layout: { lg: place, md: place, sm: place, xs: place, xxs: place } as Outputs["widgets"]["create"]["layout"],
});
