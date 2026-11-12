import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import type { MarketplaceEntry } from "./marketplace.ts";
import { readPlugin } from "./read-plugin.ts";
import { type FixtureFile, lawFirm, skillMd, writeTree } from "./test-support.ts";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

function tree(files: Record<string, FixtureFile>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dispand-definitions-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeTree(dir, files);
  return dir;
}

const entry: MarketplaceEntry = { name: "demo", source: { type: "path", path: "./" } };
const manifest = (more: Record<string, unknown> = {}) => JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "demo", ...more });
/** A standard plugin with one skill (`notes`) and one server (`search`), plus `files`. */
const read = (files: Record<string, FixtureFile>) =>
  readPlugin(
    tree({
      "plugin.json": manifest(),
      "skills/notes/SKILL.md": skillMd("notes"),
      "mcp.json": JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: { search: { type: "streamable-http", url: "https://search.example.com/mcp" } } }),
      ...files,
    }),
    entry,
  );
const reasons = (got: ReturnType<typeof read>) => got.notImported.map((n) => `${n.component} ${n.name}: ${n.reason}`);
const names = (got: ReturnType<typeof read>) => ({
  agents: got.definitions.agents.map((d) => d.name),
  primitives: got.definitions.primitives.map((d) => d.name),
  triggers: got.definitions.triggers.map((d) => d.name),
});

const json = (value: unknown) => JSON.stringify(value);
const agentMd = (frontmatter: string, body = "You help.") => `---\n${frontmatter}\n---\n\n${body}\n`;
const clients = json({ name: "Clients", primitive: true, fields: [{ name: "Email", type: "text" }] });

test("the law-firm fixture reads whole: its primitives, agents and triggers, written as the procedures' inputs with names", () => {
  const got = readPlugin(tree(lawFirm()), entry);
  expect(got.notImported).toEqual([]);
  expect(got.skills.map((s) => s.name)).toEqual(["legal-research"]);
  expect(got.mcpServers.map((s) => s.name)).toEqual(["case-law"]);
  const { definitions } = got;
  expect(definitions.description).toMatch(/^Tables for clients/);
  expect(definitions.primitives).toEqual([
    { name: "Clients", primitive: true, fields: [{ name: "Email", type: "text" }] },
    {
      name: "Matters",
      primitive: true,
      fields: [
        { name: "Clients", type: "reference", references: "Clients" },
        { name: "Conclusions", type: "long-text" },
      ],
      parent: { field: "Clients", required: false },
    },
    { name: "Research", primitive: true, fields: [{ name: "Matters", type: "reference", references: "Matters" }], parent: { field: "Matters", required: false } },
  ]);
  // Files are read in name order: drafting, intake-and-research, matter-upkeep.
  expect(definitions.agents).toEqual([
    {
      name: "Drafting",
      description: "Drafts the reply to the client from the research recorded.",
      harness: "cloud",
      skills: [],
      tools: ["catalog:gmail"],
      bundles: ["data"],
      tables: ["Matters", "Research"],
      consults: [{ agent: "Intake and research", ask: false }],
      systemPrompt: "Draft the reply to the client from the research recorded, as a draft in the mailbox.",
    },
    {
      name: "Intake and research",
      description: "Takes in each new client email, finds its client and matter, and researches it.",
      harness: "cloud",
      skills: ["legal-research"],
      tools: ["catalog:gmail", "case-law"],
      bundles: ["data"],
      tables: ["Clients", "Matters", "Research"],
      consults: [],
      systemPrompt: "Read each new client email, find its client and matter, research it and record what you found.",
    },
    {
      name: "Matter upkeep",
      description: "Keeps each matter's conclusions up to date.",
      harness: "cloud",
      skills: [],
      tools: [],
      bundles: ["data"],
      tables: ["Matters"],
      consults: [],
      systemPrompt: "Keep each matter's conclusions up to date.",
    },
  ]);
  expect(definitions.triggers).toEqual([
    { agent: "Matter upkeep", name: "Matter changed", instructions: "Update the conclusions.", concurrency: "parallel", rateCap: 60, config: { kind: "primitive", table: "Matters", operations: ["updated"] } },
    {
      agent: "Intake and research",
      name: "New client email",
      instructions: "A new email arrived.",
      concurrency: "parallel",
      rateCap: 60,
      config: {
        kind: "poll",
        catalog: "gmail",
        action: "search_threads",
        arguments: { query: "in:inbox after:{{lastPollEpoch}}", pageSize: 50 },
        itemsPath: "threads",
        idPath: "id",
        interval: 300,
        continuation: { path: "nextPageToken", argument: "pageToken" },
      },
    },
    { agent: "Drafting", name: "Research recorded", instructions: "Draft the reply.", concurrency: "parallel", rateCap: 60, config: { kind: "primitive", table: "Research", operations: ["created"] } },
  ]);
});

test("a hostile plugin: each bad definition is skipped and listed alone, and its siblings load", () => {
  const outside = tree({ "agent.md": agentMd("name: Outside") });
  const got = read({
    "plugin.json": manifest({ extensions: { "com.dispand": "not an object" } }),
    "com.dispand/primitives/clients.json": clients,
    // A path leaving the root, a link and a file past 2 MiB are never read.
    "com.dispand/primitives/escape.json": { link: "../../../outside.json" },
    "com.dispand/agents/x.md": { link: join(outside, "agent.md") },
    "com.dispand/agents/huge.md": agentMd("name: Huge", "x".repeat(3 * 1024 * 1024)),
    "com.dispand/primitives/orphan.json": json({ name: "Orphan", primitive: true, fields: [{ name: "Owner", type: "reference", references: "Elsewhere" }], parent: { field: "Owner", required: true } }),
    "com.dispand/agents/helper.md": agentMd("name: Helper\ntools: [search]\nskills: [notes]"),
    "com.dispand/triggers/lost.json": json({ agent: "Nobody", name: "Lost", config: { kind: "manual", placement: "chat" } }),
    "com.dispand/triggers/unknown-server.json": json({ agent: "Helper", name: "Poll elsewhere", config: { kind: "poll", server: "elsewhere", action: "list", idPath: "id" } }),
    "com.dispand/triggers/ok.json": json({ agent: "Helper", name: "On a client", config: { kind: "primitive", table: "Clients", operations: ["created"] } }),
    "com.dispand/triggers/on-orphan.json": json({ agent: "Helper", name: "On an orphan", config: { kind: "primitive", table: "Orphan", operations: ["created"] } }),
    "com.dispand/agents/loop.md": agentMd("name: Loop\nconsults: &x [*x]"),
  });
  expect(names(got)).toEqual({ agents: ["Helper"], primitives: ["Clients"], triggers: ["On a client"] });
  expect(reasons(got)).toEqual([
    "manifest extensions.com.dispand: Not an object: ignored",
    "definition com.dispand/primitives/escape.json: Not a regular file, or larger than 2 MiB",
    "definition com.dispand/primitives/orphan.json: Its parent table “Elsewhere” isn't a primitive of the plugin",
    "definition com.dispand/agents/huge.md: Not a regular file, or larger than 2 MiB",
    "definition com.dispand/agents/x.md: Not a regular file, or larger than 2 MiB",
    "definition com.dispand/agents/loop.md: Its frontmatter refers to itself",
    "definition com.dispand/triggers/lost.json: Its agent “Nobody” isn't an agent of the plugin",
    "definition com.dispand/triggers/on-orphan.json: Its table “Orphan” is a definition of the plugin that wasn't read",
    "definition com.dispand/triggers/unknown-server.json: “elsewhere” isn't a server of the plugin's mcp.json",
  ]);
});

test("the com.dispand manifest key holds a description only: anything else is listed and ignored", () => {
  const got = read({ "plugin.json": manifest({ extensions: { "com.dispand": { description: "Sets a firm up.", agents: ["x"] }, "org.other": 1 } }) });
  expect(got.definitions.description).toBe("Sets a firm up.");
  expect(reasons(got)).toEqual(["manifest extensions.com.dispand: It has a field other than description: ignored"]);
});

test("a definition is parsed with its procedure's rules, refinements included", () => {
  const got = read({
    "com.dispand/primitives/clients.json": clients,
    "com.dispand/primitives/bad-type.json": json({ name: "Bad", primitive: false, fields: [{ name: "X", type: "colour" }] }),
    "com.dispand/primitives/extra.json": json({ name: "Extra", primitive: false, tableId: "tbl_1" }),
    "com.dispand/primitives/half-ref.json": json({ name: "Half", primitive: false, fields: [{ name: "X", type: "text", references: "Clients" }] }),
    "com.dispand/primitives/twice.json": json({ name: "Twice", primitive: false, fields: [{ name: "A", type: "text" }, { name: "a", type: "number" }] }),
    "com.dispand/primitives/self.json": json({ name: "Self", primitive: true, fields: [{ name: "Up", type: "reference", references: "Self" }], parent: { field: "Up", required: false } }),
    "com.dispand/primitives/not-primitive.json": json({ name: "Flat", primitive: false, fields: [{ name: "C", type: "reference", references: "Clients" }], parent: { field: "C", required: false } }),
    "com.dispand/primitives/same-name.json": json({ name: "clients", primitive: false }),
    "com.dispand/primitives/readme.txt": "Not a definition.",
    "com.dispand/agents/a.md": agentMd("name: A"),
    "com.dispand/agents/model.md": agentMd("name: Model\nmodel: big"),
    "com.dispand/agents/no-frontmatter.md": "Just a prompt.",
    "com.dispand/triggers/interaction.json": json({ agent: "A", name: "Asked", config: { kind: "primitive", table: "interaction", operations: ["answered"], fields: ["x"] } }),
    "com.dispand/triggers/wrong-op.json": json({ agent: "A", name: "Answered row", config: { kind: "primitive", table: "Clients", operations: ["answered"] } }),
    "com.dispand/triggers/no-field.json": json({ agent: "A", name: "Field", config: { kind: "primitive", table: "Clients", operations: ["updated"], fields: ["Phone"] } }),
    "com.dispand/triggers/both.json": json({ agent: "A", name: "Both", config: { kind: "poll", server: "search", catalog: "gmail", action: "list", idPath: "id" } }),
    "com.dispand/triggers/tool-id.json": json({ agent: "A", name: "By id", config: { kind: "poll", toolId: "tool_1", action: "list", idPath: "id" } }),
    "com.dispand/triggers/workspace.json": json({ agent: "A", name: "Elsewhere", config: { kind: "primitive", table: "Invoices", operations: ["created"], fields: ["Total"] } }),
    "com.dispand/triggers/schedule.json": json({ agent: "A", name: "Mondays", config: { kind: "schedule", cron: "0 9 * * 1", timezone: "UTC" } }),
  });
  expect(names(got)).toEqual({ agents: ["A"], primitives: ["Clients"], triggers: ["Mondays", "Elsewhere"] });
  expect(reasons(got)).toEqual([
    "definition com.dispand/primitives/readme.txt: Not a .json file",
    "definition com.dispand/primitives/bad-type.json: fields.0.type: Invalid option: expected one of \"text\"|\"long-text\"|\"number\"|\"checkbox\"|\"date\"|\"url\"|\"attachment\"|\"single-select\"|\"reference\"",
    "definition com.dispand/primitives/extra.json: It has a field it doesn't take",
    "definition com.dispand/primitives/same-name.json: Another definition is called “clients”",
    "definition com.dispand/primitives/half-ref.json: Its field “X”: a reference field, and only it, names the table it references",
    "definition com.dispand/primitives/not-primitive.json: Only a primitive table has a parent",
    "definition com.dispand/primitives/self.json: A table can't be its own parent",
    "definition com.dispand/primitives/twice.json: It has two fields called “a”",
    "definition com.dispand/agents/model.md: It has a field it doesn't take",
    "definition com.dispand/agents/no-frontmatter.md: It has no frontmatter",
    "definition com.dispand/triggers/both.json: config.server: A poll names one server or one catalog entry",
    "definition com.dispand/triggers/interaction.json: config.fields: A Question or an Approval has no fields",
    "definition com.dispand/triggers/tool-id.json: It has a field it doesn't take in config",
    "definition com.dispand/triggers/wrong-op.json: config.operations: These changes aren't ones of what the trigger watches",
    "definition com.dispand/triggers/no-field.json: “Phone” isn't a field of “Clients”",
  ]);
});

test("a definition naming what was skipped is skipped too, and names outside the plugin are checked", () => {
  const got = read({
    "com.dispand/agents/a.md": agentMd("name: A\nconsults:\n  - agent: B\n    ask: true"),
    "com.dispand/agents/b.md": agentMd("name: B\nconsults:\n  - agent: C\n    ask: false"),
    "com.dispand/agents/c.md": agentMd("name: C\ntools: [\"catalog:no-such-entry\"]"),
    "com.dispand/agents/d.md": agentMd("name: D\nskills: [drawing]"),
    "com.dispand/agents/e.md": agentMd("name: E\nconsults:\n  - agent: E\n    ask: false"),
    "com.dispand/agents/f.md": agentMd("name: F\ntools: [\"catalog:gmail\", search]\ntables: all\nbundles: [data, configure]"),
    "com.dispand/triggers/on-a.json": json({ agent: "A", name: "Start A", config: { kind: "manual", placement: "button" } }),
    "com.dispand/primitives/top.json": json({ name: "Top", primitive: true, fields: [{ name: "Up", type: "reference", references: "Gone" }], parent: { field: "Up", required: false } }),
    "com.dispand/primitives/below.json": json({ name: "Below", primitive: true, fields: [{ name: "Top", type: "reference", references: "Top" }], parent: { field: "Top", required: false } }),
  });
  expect(names(got)).toEqual({ agents: ["F"], primitives: [], triggers: [] });
  expect(got.definitions.agents[0]).toMatchObject({ tables: "all", bundles: ["data", "configure"], tools: ["catalog:gmail", "search"] });
  expect(reasons(got)).toEqual([
    "definition com.dispand/primitives/top.json: Its parent table “Gone” isn't a primitive of the plugin",
    "definition com.dispand/primitives/below.json: Its parent table “Top” isn't a primitive of the plugin",
    "definition com.dispand/agents/c.md: “catalog:no-such-entry” isn't an entry of Dispand's catalog",
    "definition com.dispand/agents/d.md: “drawing” isn't a skill of the plugin",
    "definition com.dispand/agents/e.md: An agent can't consult itself",
    "definition com.dispand/agents/b.md: It consults “C”, which isn't an agent of the plugin",
    "definition com.dispand/agents/a.md: It consults “B”, which isn't an agent of the plugin",
    "definition com.dispand/triggers/on-a.json: Its agent “A” isn't an agent of the plugin",
  ]);
});

test("a com.dispand that isn't a folder, or a kind that isn't one, reads no definition of it", () => {
  expect(reasons(read({ "com.dispand": "a file" }))).toEqual(["definition com.dispand: Not a folder: no definition is read"]);
  const got = read({ "com.dispand/agents": "a file", "com.dispand/primitives/clients.json": clients });
  expect(names(got)).toEqual({ agents: [], primitives: ["Clients"], triggers: [] });
  expect(reasons(got)).toEqual(["definition com.dispand/agents: Not a folder: no definition of it is read"]);
});

test("a plugin holds at most 100 definitions of a kind", () => {
  const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`com.dispand/primitives/t${i}.json`, json({ name: `T${i}`, primitive: false })]));
  expect(() => read(many)).toThrow("more than 100 primitives definitions");
});

test("the Claude layout has no definitions, whatever com.dispand/ holds", () => {
  const got = readPlugin(tree({ ".claude-plugin/plugin.json": json({ name: "demo" }), "com.dispand/primitives/clients.json": clients }), entry);
  expect(got.layout).toBe("claude");
  expect(got.definitions).toEqual({ agents: [], primitives: [], triggers: [] });
});
