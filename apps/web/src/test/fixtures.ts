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
