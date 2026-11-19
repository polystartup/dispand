import { expect as baseExpect, test, type Page } from "@playwright/test";
import { startFakeMcp, type FakeMcp } from "../../../packages/domain/src/tools/test-server.ts";
import { lastResult, startFakeModel, type FakeModel } from "./fake-model.ts";
import { FakeRunner } from "./fake-runner.ts";

// The day-one acceptance: the lawyer's first conversation (script 4.1, steps 1 to 4) and the
// studio's (4.2, steps 1 and 2), on a fresh install of its own (see playwright.config.ts), the
// Assistant on a cloud harness whose model follows a script.
const SERVER = "http://localhost:3102";
const WAIT_MS = 20_000;
const expect = baseExpect.configure({ timeout: WAIT_MS });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const DESCRIPTION =
  "I am a lawyer. When a client emails me, I'd like the research done and a reply drafted for me to review. If the email is about one of our cases, add its attachments to the case and update the case's conclusions. I only want to answer the important questions and review the finished work.";

/** The description, rewritten as how this business works: what the setup keeps in the workspace's memory. */
const BUSINESS =
  "A law firm. Clients write by email: each new email is researched and a reply drafted for the lawyer to review. An email about a case adds its attachments to the case and updates the case's conclusions. The lawyer answers only the important questions and reviews finished work.";

let model: FakeModel | undefined;
let research: FakeMcp | undefined;
let runner: FakeRunner | undefined;
test.afterAll(async () => {
  runner?.close();
  await research?.close();
  await model?.close();
});

/** What the lawyer's run left for the studio's: the owner signs in again with these. */
const ids = { cloud: "", assistant: "", platformSkill: "" };

async function rpc<T>(page: Page, path: string, input?: unknown): Promise<T> {
  // maxRetries retries only ECONNRESET: a reused keep-alive socket the server closed while idle.
  const res = await page.request.post(`/api/rpc/${path}`, { maxRetries: 1, headers: { "x-csrf-token": "orpc" }, data: input === undefined ? {} : { json: input } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { json: T }).json;
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

type Applied = { items: { $item: number; tool: string; outcome: string; id?: string; error?: string }[]; next: string };
const use = (name: string, args: unknown, text?: string) => () => ({ ...(text ? { text } : {}), call: { name, args } });
/** request_approval of the proposal `propose` just made. */
const ask = (message: string) => (m: Parameters<typeof lastResult>[0]) => ({ call: { name: "request_approval", args: { message, proposal: lastResult<{ proposalId: string }>(m).proposalId } } });

/** Approves the proposal shown in the chat, after checking it lists `count` items, each whole. */
async function approve(page: Page, count: number, texts: string[]) {
  const chat = page.getByRole("region", { name: "Stem" });
  const approved = chat.getByText("You approved it");
  const before = await approved.count();
  await expect(chat.getByRole("button", { name: "Approve" })).toBeVisible();
  const card = chat.getByRole("region", { name: "Proposal" }).last();
  await expect(card.getByRole("list", { name: "What is proposed" }).getByRole("listitem")).toHaveCount(count);
  for (const text of texts) await expect(card).toContainText(text);
  if (texts.includes("Other enabled actions ask")) await page.screenshot({ path: test.info().outputPath("agent-tool-permissions.png"), animations: "disabled" });
  await chat.getByRole("button", { name: "Approve" }).click();
  await expect(approved).toHaveCount(before + 1);
}

type Table = { id: string; name: string; primitive: boolean; parent: { tableId: string } | null };
type Trigger = { name: string; agentId: string; config: Record<string, unknown> };

/** Every table, read whole. */
async function tables(page: Page): Promise<Table[]> {
  const list = await rpc<{ id: string }[]>(page, "tables/list");
  return Promise.all(list.map((t) => rpc<Table>(page, "tables/get", { id: t.id })));
}

/** Every agent's triggers. */
async function triggers(page: Page): Promise<Trigger[]> {
  const agents = await rpc<{ id: string }[]>(page, "agents/list");
  return (await Promise.all(agents.map((a) => rpc<Trigger[]>(page, "triggers/list", { agentId: a.id })))).flat();
}

test("the lawyer: a fresh install's Assistant sets up the whole workspace from one description and one approval", async ({ page }) => {
  model = await startFakeModel("scripted-model");
  research = await startFakeMcp([{ name: "search_case_law", description: "Search published decisions", annotations: { readOnlyHint: true } }]);

  // 1. Fresh install: the owner signs up and lands on the Assistant, which asks where it runs.
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Name").fill("Ada");
  await page.getByLabel("Setup code").fill("dev-setup-code-0123456789");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/assistant$/);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add a harness" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: /^Cloud/ }).click();
  await sheet.getByLabel("Name").fill("Cloud model");
  await sheet.getByLabel("Provider").click();
  await page.getByRole("option", { name: "OpenAI-compatible" }).click();
  await sheet.getByLabel("Base URL").fill(model.baseUrl);
  await sheet.getByLabel("Name").click();
  await sheet.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "scripted-model" }).click();
  await sheet.getByRole("button", { name: "Create harness" }).click();
  await expect(sheet).toHaveCount(0);
  await page.getByRole("button", { name: "Start Stem" }).click();
  const chat = page.getByRole("region", { name: "Stem" });
  await expect(chat.getByText("Describe your business or use case and how you'd like to automate it.")).toBeVisible();

  // What the model reads with harnesses_limits and agents_get, known to the script up front.
  ids.cloud = (await rpc<{ id: string }[]>(page, "harnesses/list"))[0]!.id;
  ids.assistant = (await rpc<{ agentId: string }>(page, "agents/assistant")).agentId;
  ids.platformSkill = (await rpc<{ skills: { packageId: string }[] }>(page, "agents/get", { id: ids.assistant })).skills[0]!.packageId;
  const agent = (name: string, systemPrompt: string, toolIds: unknown[], dataTables: unknown[]) => ({ name, harnessId: ids.cloud, systemPrompt, skillPackageIds: [], toolIds, bundles: ["data"], dataTables });
  const items = [
    /* 0 */ { tool: "tables_create", input: { name: "Clients" } },
    /* 1 */ { tool: "tables_set_primitive", input: { id: { $item: 0 }, primitive: true } },
    /* 2 */ { tool: "tables_create", input: { name: "Matters" } },
    /* 3 */ { tool: "tables_set_primitive", input: { id: { $item: 2 }, primitive: true, parent: { tableId: { $item: 0 }, required: false } } },
    /* 4 */ { tool: "fields_create", input: { tableId: { $item: 2 }, name: "Conclusions", type: "long-text" } },
    /* 5 */ { tool: "tables_create", input: { name: "Research" } },
    /* 6 */ { tool: "tables_set_primitive", input: { id: { $item: 5 }, primitive: true, parent: { tableId: { $item: 2 }, required: false } } },
    /* 7 */ { tool: "tools_add_from_catalog", input: { catalogId: "gmail" } },
    /* 8 */ { tool: "tools_add", input: { name: "Case law", url: research.url, transport: "streamable-http" } },
    /* 9 */ { tool: "agents_create", input: agent("Intake and research", "Read each new client email, find its client and matter, research it and record what you found.", [{ $item: 7 }, { $item: 8 }], [{ $item: 0 }, { $item: 2 }, { $item: 5 }]) },
    /* 10 */ { tool: "agents_create", input: agent("Drafting", "Draft the reply to the client from the research recorded, as a draft in the mailbox.", [{ $item: 7 }], [{ $item: 2 }, { $item: 5 }]) },
    /* 11 */ { tool: "agents_create", input: agent("Matter upkeep", "Keep each matter's conclusions up to date.", [], [{ $item: 2 }]) },
    /* 12 */ { tool: "agents_set_tool_permission", input: { agentId: { $item: 9 }, toolId: { $item: 7 }, action: "create_draft", permission: "ask" } },
    /* 13 */ {
      tool: "triggers_create",
      input: { agentId: { $item: 9 }, name: "New client email", instructions: "A new email arrived.", config: { kind: "poll", toolId: { $item: 7 }, action: "search_threads", arguments: { query: "in:inbox after:{{lastPollEpoch}}", pageSize: 50 }, itemsPath: "threads", idPath: "id", continuation: { path: "nextPageToken", argument: "pageToken" } } },
    },
    /* 14 */ { tool: "triggers_create", input: { agentId: { $item: 10 }, name: "Research recorded", instructions: "Draft the reply.", config: { kind: "primitive", tableId: { $item: 5 }, operations: ["created"] } } },
    /* 15 */ { tool: "triggers_create", input: { agentId: { $item: 11 }, name: "Matter changed", instructions: "Update the conclusions.", config: { kind: "primitive", tableId: { $item: 2 }, operations: ["updated"] } } },
    /* 16 */ { tool: "memory_add", input: { scope: "workspace", path: "business.md", name: "How this firm works", description: "A law firm: client emails researched, replies drafted for review, matters kept up to date", type: "business", body: BUSINESS } },
  ];
  model.script(
    use("propose", { items, plugin: "Law firm" }, "Ok, let me set this up in Dispand."),
    ask("Here is the setup I propose: client, matter and research tables, three agents, Gmail and a case-law search, and the triggers wiring them. Do you want to modify anything, or shall I go ahead?"),
    (m) => ({ call: { name: "proposal_apply", args: { proposalId: proposalOf(m) } } }),
    (m) => ({ call: { name: "tools_get", args: { id: lastResult<Applied>(m).items[7]!.id } } }),
    (m) => ({ text: `I have set up Dispand for you. How about you start by connecting your email account: [Gmail](${lastResult<{ signInPath: string }>(m).signInPath}).` }),
  );

  // 2. The description; the proposal is one Approval in the chat, every item shown.
  await chat.getByLabel("Message", { exact: true }).fill(DESCRIPTION);
  await chat.getByRole("button", { name: "Send" }).click();
  await approve(page, items.length, ["Clients", "Matters", "Research", "Gmail", "Case law", "Intake and research", "Drafting", "Matter upkeep", "New client email", "Add an entry to a memory", "How this firm works", "Do you want to modify anything", "Runs without asking:", "Other enabled actions ask"]);

  // 4. The last message links to the mail tool's page, which says it needs a sign-in.
  const link = chat.getByRole("button", { name: "Gmail", exact: true });
  await expect(link).toBeVisible();
  const applied = lastResult<Applied>(model.requests[3]!);
  expect(applied.items.map((i) => i.outcome)).toEqual(Array(items.length).fill("made"));
  expect(applied.next).toBe("Every item is made.");
  await link.click();
  await expect(page).toHaveURL(/\/settings\/tools\?tool=tool_/);
  await expect(page.getByRole("dialog").getByText("Not connected yet: sign in to the server to list its actions.")).toBeVisible();
  await page.keyboard.press("Escape");

  // 3. The configuration exists under Data, Agents, Tools and Triggers.
  await page.goto("/settings/data");
  for (const name of ["Clients", "Matters", "Research"]) await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
  const all = await tables(page);
  const table = (name: string) => all.find((t) => t.name === name)!;
  expect(table("Matters")).toMatchObject({ primitive: true, parent: { tableId: table("Clients").id } });
  expect(table("Research")).toMatchObject({ primitive: true, parent: { tableId: table("Matters").id } });

  await page.goto("/settings/agents");
  for (const name of ["Stem", "Intake and research", "Drafting", "Matter upkeep"]) await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
  await page.goto("/settings/tools");
  await expect(page.getByRole("button", { name: /^Gmail/ })).toContainText("Not connected yet");
  await expect(page.getByRole("button", { name: /^Case law/ })).toContainText("1 action");

  const agents = await rpc<{ id: string; name: string }[]>(page, "agents/list");
  const intake = agents.find((a) => a.name === "Intake and research")!;
  await page.goto(`/settings/agents/${intake.id}`);
  await page.getByRole("tab", { name: "Triggers" }).click();
  await expect(page.getByRole("button", { name: /^New client email Poll/ })).toBeVisible();
  expect((await triggers(page)).filter((t) => t.agentId !== ids.assistant).map((t) => [t.name, t.config.kind]).sort()).toEqual([
    ["Matter changed", "primitive"],
    ["New client email", "poll"],
    ["Research recorded", "primitive"],
  ]);

  // The business is in the workspace's memory, written by Stem's Job, not in Stem's instructions; the setup is one generated plugin.
  const memory = await rpc<{ entries: { path: string; type: string; body: string; author: { type: string } }[] }>(page, "memories/list", { scope: "workspace" });
  expect(memory.entries).toEqual([expect.objectContaining({ path: "business.md", type: "business", body: BUSINESS, author: expect.objectContaining({ type: "agent" }) })]);
  const assistant = await rpc<{ systemPrompt: string; selfLearning: string[]; skills: { packageId: string }[] }>(page, "agents/get", { id: ids.assistant });
  expect(assistant.systemPrompt).toBe("");
  expect(assistant.selfLearning).toEqual(["workspace"]);
  expect(assistant.skills.map((s) => s.packageId)).toEqual([ids.platformSkill]);
  await page.goto("/settings/memory");
  await expect(page.getByRole("main").getByText("How this firm works")).toBeVisible();
  await page.goto("/settings/plugins/installed");
  await expect(page.getByText("Generated: Law firm")).toBeVisible();
});

/** The proposal the last request_approval asked about, from the model's own call. */
function proposalOf(messages: Parameters<typeof lastResult>[0]): string {
  const call = messages.findLast((m) => m.tool_calls?.some((c) => c.function.name === "request_approval"))!.tool_calls!.find((c) => c.function.name === "request_approval")!;
  return (JSON.parse(call.function.arguments) as { proposal: string }).proposal;
}

test("the studio: a second conversation's setup stops at a name taken, goes on, and is completed by a second proposal", async ({ page }) => {
  test.skip(!model || !ids.assistant, "needs the lawyer's install, from the test above");
  await signIn(page);
  // The studio's design agent runs on the owner's machine: a paired Claude Code runner.
  const created = await rpc<{ runnerId: string; pairingCode: string }>(page, "runners/create", { name: "Workstation" });
  runner = await FakeRunner.pair(SERVER, created.pairingCode);
  const cli = await rpc<{ id: string }>(page, "harnesses/create", { name: "Claude on Workstation", runnerId: created.runnerId, kind: "claude-code", permissionMode: "default" });

  const first = [
    /* 0 */ { tool: "tables_create", input: { name: "Products" } },
    /* 1 */ { tool: "tables_set_primitive", input: { id: { $item: 0 }, primitive: true } },
    /* 2 */ { tool: "tables_create", input: { name: "Features" } },
    /* 3 */ { tool: "tables_set_primitive", input: { id: { $item: 2 }, primitive: true, parent: { tableId: { $item: 0 }, required: true } } },
    /* 4 */ { tool: "fields_create", input: { tableId: { $item: 2 }, name: "Pull request", type: "url" } },
  ];
  /** The rest of the setup, with these ids for the products and features tables. */
  const rest = (products: unknown, features: unknown, at: number) => [
    { tool: "tools_add_from_catalog", input: { catalogId: "github" } },
    { tool: "agents_create", input: { name: "Designer", harnessId: cli.id, systemPrompt: "Propose each new feature's design in its product's repository and open a pull request; write its link on the feature.", skillPackageIds: [], toolIds: [{ $item: at }], bundles: ["data"], dataTables: [products, features] } },
    { tool: "agents_create", input: { name: "Website reviewer", harnessId: ids.cloud, systemPrompt: "Review each product's website copy.", skillPackageIds: [], toolIds: [], bundles: ["data"], dataTables: [products] } },
    { tool: "triggers_create", input: { agentId: { $item: at + 1 }, name: "New feature", instructions: "Design this feature.", config: { kind: "primitive", tableId: features, operations: ["created"] } } },
    { tool: "triggers_create", input: { agentId: { $item: at + 2 }, name: "Monday review", instructions: "Review every product's website copy.", config: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Paris" } } },
  ];
  const items = [...first, ...rest({ $item: 0 }, { $item: 2 }, first.length)];
  const owned = { features: "" };
  // The requests of this conversation, from the first.
  const base = model!.requests.length;
  const request = (n: number) => model!.requests[base + n]!;
  model!.script(
    use("propose", { items, plugin: "Software studio" }),
    ask("Here is the studio's setup: products and features, a designer on your machine with GitHub, and a website reviewer every Monday. Shall I go ahead?"),
    (m) => ({ call: { name: "proposal_apply", args: { proposalId: proposalOf(m) } } }),
    (m) => ({ text: `I made the first items, then stopped: ${lastResult<Applied>(m).next}` }),
    // "Use mine": apply again goes on from the first item not made.
    (m) => ({ call: { name: "proposal_apply", args: { proposalId: proposalOf(m) } } }),
    use("tables_list", {}),
    (m) => {
      // From the second apply's result: what item 0 made.
      const products = lastResult<Applied>(request(5)).items[0]!.id!;
      const setup = [
        { tool: "tables_set_primitive", input: { id: owned.features, primitive: true, parent: { tableId: products, required: true } } },
        { tool: "fields_create", input: { tableId: owned.features, name: "Pull request", type: "url" } },
        ...rest(products, owned.features, 2),
      ];
      expect(lastResult<{ name: string }[]>(m).map((t) => t.name)).toContain("Features");
      return { call: { name: "propose", args: { items: setup, plugin: "Software studio" } } };
    },
    ask("The rest of the setup, on your Features table. Shall I go ahead?"),
    (m) => ({ call: { name: "proposal_apply", args: { proposalId: proposalOf(m) } } }),
    (m) => ({ call: { name: "tools_get", args: { id: lastResult<Applied>(m).items[2]!.id } } }),
    (m) => ({ text: `The studio is set up. Give GitHub its token to let the designer open pull requests: [GitHub](${lastResult<{ signInPath: string }>(m).signInPath}).` }),
  );

  await page.goto("/assistant?run=new");
  const chat = page.getByRole("region", { name: "Stem" });
  const box = chat.getByLabel("Message", { exact: true });
  await box.fill(
    "I run a studio that builds software products. Each product has features; when a feature is created, an agent on my machine should propose its design in the repository and open a pull request; every Monday, review each product's website copy.",
  );
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(chat.getByRole("region", { name: "Proposal" })).toBeVisible();
  // Meanwhile the owner made a Features table of their own: the proposal's is a name taken.
  owned.features = (await rpc<{ id: string }>(page, "tables/create", { name: "Features" })).id;
  await approve(page, items.length, ["Products", "Features", "GitHub", "Designer", "Website reviewer", "Monday review"]);

  // Apply stopped at the name taken: what names it was never run, and the agent says why.
  await expect(chat.getByText(/I made the first items, then stopped: Item 3 \(tables_create\) was refused/)).toBeVisible();
  const stopped = lastResult<Applied>(request(3));
  expect(stopped.items.map((i) => i.outcome)).toEqual(["made", "made", "refused", ...Array(items.length - 3).fill("not made")]);
  expect(stopped.items[2]!.error).toMatch(/Features/);
  expect((await rpc<{ name: string }[]>(page, "agents/list")).map((a) => a.name)).not.toContain("Designer");

  // Applied again, it goes on from the first item not made: that one names the refused item, so it can't run.
  await box.fill("Use the Features table I made.");
  await box.press("Enter");
  await approve(page, 7, ["Pull request", "GitHub", "Designer", "Website reviewer", "New feature", "Monday review"]);
  const again = lastResult<Applied>(request(5));
  expect(again.items.slice(0, 4).map((i) => i.outcome)).toEqual(["made before", "made before", "refused before", "refused"]);
  expect(again.items[3]!.error).toMatch(/names an item that created nothing/);

  await expect(chat.getByRole("button", { name: "GitHub", exact: true })).toBeVisible();
  const done = lastResult<Applied>(request(9));
  expect(done.items.map((i) => i.outcome)).toEqual(Array(7).fill("made"));

  // Everything listed exists once, wired to the owner's Features table.
  const all = await tables(page);
  const products = all.find((t) => t.name === "Products")!;
  expect(all.filter((t) => t.name === "Features")).toEqual([expect.objectContaining({ id: owned.features, primitive: true, parent: expect.objectContaining({ tableId: products.id }) })]);
  const agents = await rpc<{ id: string; name: string; harnessId: string; dataTables: unknown }[]>(page, "agents/list");
  const designer = agents.find((a) => a.name === "Designer")!;
  expect(designer).toMatchObject({ harnessId: cli.id, dataTables: [products.id, owned.features] });
  expect(agents.find((a) => a.name === "Website reviewer")).toMatchObject({ harnessId: ids.cloud });
  const made = await triggers(page);
  expect(made.find((t) => t.name === "New feature")).toMatchObject({ agentId: designer.id, config: { kind: "primitive", tableId: owned.features } });
  expect(made.find((t) => t.name === "Monday review")).toMatchObject({ config: { kind: "schedule", cron: "0 9 * * 1" } });

  await chat.getByRole("button", { name: "GitHub", exact: true }).click();
  await expect(page.getByRole("dialog").getByText(/^Needs sign-in: enter its Personal access token/)).toBeVisible();
});

test("Assistant settings selects the next conversation's harness and model; chat fills desktop and mobile", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/assistant?run=new");
  const created = await rpc<{ pairingCode: string; runnerId: string }>(page, "runners/create", { name: "Assistant settings runner" });
  const settingsRunner = await FakeRunner.pair(SERVER, created.pairingCode);
  try {
    await rpc(page, "harnesses/create", { name: "Assistant settings CLI", runnerId: created.runnerId, kind: "claude-code", permissionMode: "default" });
    await page.getByRole("button", { name: "Stem settings" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("group", { name: "Assistant settings CLI", exact: true }).getByRole("button", { name: "Sonnet", exact: true }).click();
    await sheet.getByRole("button", { name: "Save settings" }).click();
    await expect(sheet).toHaveCount(0);
    const chat = page.getByRole("region", { name: "Stem", exact: true });
    await chat.getByRole("button", { name: "Set up an agent", exact: true }).click();
    await expect(chat.getByLabel("Message", { exact: true })).toHaveValue("Help me set up an agent for a recurring task.");
    await chat.getByLabel("Message", { exact: true }).fill("Use the selected harness and model.");
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    const { start } = await settingsRunner.waitFor("session.start", WAIT_MS);
    expect(start.harness).toBe("claude-code");
    expect(start.model).toBe("sonnet");
    // The session starts before the chat's first message is persisted and delivered.
    expect(await settingsRunner.waitFor("session.send", WAIT_MS)).toMatchObject({ sessionId: start.sessionId, text: "Use the selected harness and model." });
    settingsRunner.emit(start.sessionId, { type: "tool", name: "Read workspace", status: "started" });
    settingsRunner.emit(start.sessionId, { type: "tool", name: "Inspect settings", status: "started" });
    settingsRunner.emit(start.sessionId, { type: "text", delta: "Using your selected settings." });
    await expect(chat.getByText("Using your selected settings.")).toBeVisible();
    const activity = chat.getByRole("button", { name: "2 tool calls", exact: true });
    await expect(activity).toHaveAttribute("aria-expanded", "false");
    await expect(chat.getByText("Read workspace", { exact: true })).toHaveCount(0);
    await activity.focus();
    await page.keyboard.press("Enter");
    await expect(activity).toHaveAttribute("aria-expanded", "true");
    await expect(chat.getByText("Read workspace", { exact: true })).toBeVisible();
    await expect(chat.getByText("Inspect settings", { exact: true })).toBeVisible();
    await page.keyboard.press("Space");
    await expect(activity).toHaveAttribute("aria-expanded", "false");

    await chat.getByText("Using your selected settings.", { exact: true }).evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.getByRole("button", { name: "Quote in reply", exact: true }).click();
    await expect(chat.getByLabel("Quoted text", { exact: true })).toContainText("Using your selected settings.");

    const chooser = page.waitForEvent("filechooser");
    await chat.getByRole("button", { name: "Attach a file", exact: true }).click();
    await (await chooser).setFiles({
      name: "workspace.png", mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAAz0lEQVR4nO3QAQ2DUABEMYzNBtLmawamAgHIePeTJlXQ63N/j/P7P8e58jXRu/I10btEixady9dE7xItWnQuXxO9S7Ro0bl8TfQu0aJF5/I10btEixady9dE7xItWnQuXxO9S7Ro0bl8TfQu0aJF5/I10btEixady9dE7xItWnQuXxO9S7Ro0bl8TfQu0aJF5/I10btEixady9dE7xItWnQuXxO9S7Ro0bl8TfQu0aJF5/I10btEixady9dE7xItWnQuXxO9S7Ro0bl8TfSuF1amNSq9vLDUAAAAAElFTkSuQmCC", "base64"),
    });
    const preview = chat.getByRole("button", { name: "Preview workspace.png", exact: true });
    await expect(preview).toBeVisible();
    await expect(preview.getByRole("img")).toHaveAttribute("src", /^\/files\/att_/);
    settingsRunner.emit(start.sessionId, { type: "turn-start", turnId: "settings_turn_1", interruptible: true });
    const stop = chat.getByRole("button", { name: "Stop response", exact: true });
    await expect(stop).toBeVisible();
    await chat.getByLabel("Message", { exact: true }).fill("Continue with this workspace.");
    const conversationUrl = page.url();
    const runId = new URL(conversationUrl).searchParams.get("run")!;
    expect(runId).toMatch(/^run_/);

    for (const expanded of [false, true]) {
      if (expanded) await page.getByRole("button", { name: "Full page", exact: true }).click();
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await expect(chat.getByLabel("Message", { exact: true })).toBeInViewport();
        const bounds = (await chat.boundingBox())!;
        expect(bounds.x + bounds.width).toBeGreaterThan(viewport.width - 30);
        expect(bounds.y + bounds.height).toBeGreaterThan(viewport.height - 30);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
        expect(bounds.height).toBeGreaterThan(viewport.height * 0.5);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
        await expect(preview).toBeInViewport();
        await expect(stop).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath(`assistant-${expanded ? "full" : "normal"}-${viewport.width}.png`), animations: "disabled" });
        if (!expanded) await page.screenshot({ path: testInfo.outputPath(`chat-stop-${viewport.width === 1440 ? "desktop" : "phone"}.png`), animations: "disabled" });
        await preview.click();
        const imageDialog = page.getByRole("dialog", { name: "workspace.png", exact: true });
        await expect(imageDialog).toBeVisible();
        await expect(imageDialog.getByRole("img", { name: "workspace.png" })).toBeVisible();
        await expect(imageDialog.getByRole("img")).toHaveJSProperty("naturalWidth", 120);
        await page.screenshot({ path: testInfo.outputPath(`assistant-preview-${expanded ? "full" : "normal"}-${viewport.width}.png`), animations: "disabled" });
        await page.keyboard.press("Escape");
        await expect(imageDialog).toHaveCount(0);
        await expect(preview).toBeFocused();
      }
    }
    await page.getByRole("button", { name: "Exit full page" }).click();
    await stop.focus();
    await page.keyboard.press("Enter");
    const interrupt = await settingsRunner.waitFor("session.interrupt", WAIT_MS);
    expect(interrupt).toMatchObject({ sessionId: start.sessionId, turnId: "settings_turn_1", requestId: expect.any(String) });
    await expect(stop).toBeDisabled();
    settingsRunner.emit(start.sessionId, { type: "turn-end", turnId: "settings_turn_1" });
    settingsRunner.emit(start.sessionId, { type: "interrupt-result", requestId: interrupt.requestId!, turnId: "settings_turn_1", outcome: "requested" });
    await expect(stop).toHaveCount(0);
    await expect(page).toHaveURL(conversationUrl);
    await expect(chat.getByLabel("Message", { exact: true })).toHaveValue("Continue with this workspace.");
    await expect(chat.getByLabel("Quoted text", { exact: true })).toContainText("Using your selected settings.");
    await expect(preview).toBeVisible();
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    const followUp = await settingsRunner.waitFor("session.send", WAIT_MS);
    expect(followUp.sessionId).toBe(start.sessionId);
    expect(followUp.text).toMatch(/^Continue with this workspace\.\n\n> Using your selected settings\.\n\nFiles attached/);
    expect(followUp.text).toContain("attached as “workspace.png”");
    expect(settingsRunner.received.filter((message) => message.type === "session.start")).toHaveLength(1);
    settingsRunner.emit(start.sessionId, { type: "turn-start", turnId: "settings_turn_2", interruptible: true });
    settingsRunner.emit(start.sessionId, { type: "text", delta: "Continuing in the same conversation." });
    settingsRunner.emit(start.sessionId, { type: "turn-end", turnId: "settings_turn_2" });
    await expect(chat.getByText("Continuing in the same conversation.", { exact: true })).toBeVisible();
    await expect(stop).toHaveCount(0);
    await expect(page).toHaveURL(conversationUrl);
    const continued = await rpc<{ run: { id: string; status: string }; steps: { turnStatus: string }[] }>(page, "runs/get", { runId });
    expect(continued.run).toMatchObject({ id: runId, status: "running" });
    expect(continued.steps[0]?.turnStatus).toBe("idle");
    await page.reload();
    await page.getByRole("button", { name: "Stem settings" }).click();
    await expect(sheet.getByLabel("Model", { exact: true })).toHaveValue("sonnet");
    await sheet.getByLabel("Model", { exact: true }).fill("");
    await sheet.getByRole("button", { name: "Save settings" }).click();
    await expect(sheet).toHaveCount(0);
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect(chat.getByRole("button", { name: "Set up an agent", exact: true })).toBeVisible();
    await chat.getByLabel("Message", { exact: true }).fill("Use the default model.");
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    expect((await settingsRunner.waitFor("session.start", WAIT_MS)).start.model).toBeUndefined();
  } finally {
    settingsRunner.close();
  }
});

test("Assistant slash picker offers installed Dispand skills and inserts an editable invocation", async ({ page }) => {
  await signIn(page);
  const agent = await rpc<{ id: string; name: string; systemPrompt: string; skills: { packageId: string }[] }>(page, "agents/get", { id: ids.assistant });
  await rpc(page, "agents/update", { id: agent.id, name: agent.name, systemPrompt: agent.systemPrompt, harnessId: ids.cloud, skillPackageIds: agent.skills.map((s) => s.packageId), toolIds: [] });
  await rpc(page, "skills/create", { name: "picker-test", description: "A skill installed in Dispand", instructions: "Help with the request.", requiredToolIds: [] });
  await page.goto("/assistant?run=new");
  const box = page.getByLabel("Message", { exact: true });
  const menu = page.getByRole("listbox", { name: "Commands and skills" });
  await box.fill("/no-matching-command");
  await expect(page.getByText("No matching commands or skills.", { exact: true })).toBeVisible();
  await box.press("Tab");
  await expect(box).not.toBeFocused();
  await expect(menu).toHaveCount(0);
  await expect(box).toHaveValue("/no-matching-command");
  await box.fill("/picker");
  const option = page.getByRole("option", { name: /picker-test:picker-test/ });
  await expect(option).toBeVisible();
  await expect(option).toContainText("Dispand");
  await box.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("/picker");
  await box.fill("/pick");
  await expect(option).toBeVisible();
  const viewport = page.viewportSize()!;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(option).toBeInViewport();
    await expect(box).toBeFocused();
    await page.screenshot({ path: test.info().outputPath(`assistant-slash-picker-${width}.png`), animations: "disabled" });
  }
  await page.setViewportSize(viewport);
  await box.press("Enter");
  await expect(box).toHaveValue("/picker-test:picker-test ");
  await box.pressSequentially("with these arguments");
  await expect(box).toHaveValue("/picker-test:picker-test with these arguments");
  await expect(menu).toHaveCount(0);
  const catalog = await rpc<{ entries: { name: string; source: string; skillId?: string }[] }>(page, "assistantCommands", { agentId: ids.assistant });
  const selected = catalog.entries.find((entry) => entry.name === "picker-test:picker-test" && entry.source === "dispand")!;
  expect(selected.skillId).toBeTruthy();
  model!.script(() => ({ text: "Skill request received." }));
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/rpc/runs/sendChat") && request.method() === "POST");
  await box.press("Enter");
  expect((await sent).postDataJSON()).toMatchObject({ json: { text: "/picker-test:picker-test with these arguments", skillId: selected.skillId } });
  await expect(page.getByText("Skill request received.", { exact: true })).toBeVisible();
});

test("an authorized record read stays inline across reload without another tool call", async ({ page }, testInfo) => {
  await signIn(page);
  const agent = await rpc<{ id: string; name: string; systemPrompt: string; skills: { packageId: string }[] }>(page, "agents/get", { id: ids.assistant });
  await rpc(page, "agents/update", { id: agent.id, name: agent.name, systemPrompt: agent.systemPrompt, harnessId: ids.cloud, skillPackageIds: agent.skills.map((skill) => skill.packageId), toolIds: [] });
  const table = await rpc<{ id: string; fields: { id: string }[] }>(page, "tables/create", { name: "Contract reviews" });
  const nameId = table.fields[0]!.id;
  const summary = await rpc<{ id: string }>(page, "fields/create", { tableId: table.id, name: "Summary", type: "long-text" });
  const tasks = await rpc<{ id: string }>(page, "fields/create", { tableId: table.id, name: "Open tasks", type: "number" });
  const reviewed = await rpc<{ id: string }>(page, "fields/create", { tableId: table.id, name: "Reviewed", type: "checkbox" });
  const row = await rpc<{ id: string }>(page, "rows/create", { tableId: table.id, values: {
    [nameId]: "Supplier renewal",
    [summary.id]: "Review the renewal terms before approval.",
    [tasks.id]: 0,
    [reviewed.id]: false,
  } });
  const before = model!.requests.length;
  model!.script(
    use("rows_get", { id: row.id }, "I’ll read the saved contract review."),
    () => ({ text: "The saved record is shown above." }),
  );
  await page.goto("/assistant?run=new");
  const chat = page.getByRole("region", { name: "Stem", exact: true });
  await chat.getByLabel("Message", { exact: true }).fill("Show the supplier renewal record.");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  await expect(chat.getByText("The saved record is shown above.", { exact: true })).toBeVisible();
  const record = chat.getByRole("button", { name: "Record result", exact: true });
  await expect(record).toHaveAttribute("aria-expanded", "true");
  await expect(chat.getByText("Supplier renewal", { exact: true })).toBeVisible();
  await expect(chat.getByText("Review the renewal terms before approval.", { exact: true })).toBeVisible();
  await expect(chat.getByText("Open tasks", { exact: true })).toBeVisible();
  await expect(chat.getByText("0", { exact: true })).toBeVisible();
  await expect(chat.getByText("No", { exact: true })).toBeVisible();
  expect(model!.requests).toHaveLength(before + 2);
  expect(lastResult<{ id: string }>(model!.requests.at(-1)!)).toMatchObject({ id: row.id });
  const runId = new URL(page.url()).searchParams.get("run")!;
  const reads = () => rpc<{ rows: { result: string; details: { tool?: string } }[] }>(page, "audit/list", { jobId: runId, action: "platform.call" });
  expect((await reads()).rows.filter((entry) => entry.details.tool === "rows_get")).toEqual([expect.objectContaining({ result: "ok" })]);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await record.scrollIntoViewIfNeeded();
    await expect(record).toBeInViewport();
    await expect(chat.getByText("Supplier renewal", { exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`chat-record-${viewport.width === 1440 ? "desktop" : "phone"}.png`), animations: "disabled" });
  }
  await record.focus();
  await page.keyboard.press("Enter");
  await expect(record).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Space");
  await expect(chat.getByText("Supplier renewal", { exact: true })).toBeVisible();
  await rpc(page, "rows/update", { id: row.id, values: { [nameId]: "Changed after the read" } });
  let liveReads = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/rpc/rows/get")) liveReads++; });
  await page.reload();
  await expect(chat.getByRole("button", { name: "Record result", exact: true })).toHaveCount(1);
  await expect(chat.getByText("Supplier renewal", { exact: true })).toBeVisible();
  await expect(chat.getByText("Changed after the read", { exact: true })).toHaveCount(0);
  expect(model!.requests).toHaveLength(before + 2);
  expect((await reads()).rows.filter((entry) => entry.details.tool === "rows_get")).toHaveLength(1);
  expect(liveReads).toBe(0);
});

// An artifact made to try every way out: the page policy, the frame's and the opaque origin must stop each one.
const PROBE = "https://cdn.artifact-probe.test";
const ARTIFACT = `<style>body{font-family:system-ui,sans-serif;margin:0;padding:12px}button{margin:4px 4px 0 0}</style>
<h3 style="margin:0 0 8px">Tasks done this week</h3>
<svg id="chart" width="320" height="120" role="img" aria-label="Bar chart"></svg>
<p id="out">pending</p>
<link rel="stylesheet" href="${PROBE}/style.css">
<img id="probe-img" alt="" src="${PROBE}/pixel.png">
<script src="${PROBE}/script.js"></script>
<button id="ask" onclick="sendPrompt('Draw it bigger')">Ask for more</button>
<button id="plain" onclick="openLink('http://example.org/plain')">Plain link</button>
<button id="docs" onclick="openLink('https://example.org/guide')">Guide</button>
<button id="leave" onclick="location.href='${PROBE}/nav'">Leave</button>
<script>
  const days = [3, 5, 2, 6, 4];
  document.getElementById("chart").innerHTML = days.map((n, i) => '<rect x="' + (i * 60 + 10) + '" y="' + (110 - n * 16) + '" width="40" height="' + n * 16 + '" fill="#4f6bed"/>').join("");
  const r = { external: typeof window.probeLoaded };
  const attempt = (key, f) => { try { f(); r[key] = "open"; } catch (e) { r[key] = e.name; } };
  attempt("cookie", () => document.cookie);
  attempt("storage", () => localStorage.length);
  attempt("parent", () => parent.document.body);
  fetch("/api/rpc/artifact-probe").then(() => "reached", () => "blocked").then((rpc) => { document.getElementById("out").textContent = JSON.stringify({ ...r, rpc }); });
</script>`;

test("a generated artifact shows as a card, runs only after Run, in a frame that reaches nothing", async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await signIn(page);
  const agent = await rpc<{ id: string; name: string; systemPrompt: string; skills: { packageId: string }[] }>(page, "agents/get", { id: ids.assistant });
  await rpc(page, "agents/update", { id: agent.id, name: agent.name, systemPrompt: agent.systemPrompt, harnessId: ids.cloud, skillPackageIds: agent.skills.map((skill) => skill.packageId), toolIds: [] });
  // Anything the probe host or the probe procedure gets would be answered: a request blocked is one the browser never sent.
  const reached: string[] = [];
  await context.route(`${PROBE}/**`, (route) => { reached.push(route.request().url()); return route.fulfill({ status: 200, contentType: route.request().url().endsWith(".js") ? "text/javascript" : "text/plain", body: "window.probeLoaded = true;" }); });
  await context.route("**/api/rpc/artifact-probe", (route) => { reached.push(route.request().url()); return route.fulfill({ status: 200, body: "{}" }); });
  let codeReads = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/rpc/artifacts/get")) codeReads++; });

  const before = model!.requests.length;
  model!.script(
    use("artifact_show", { title: "Weekly tasks", format: "html", code: ARTIFACT }, "Here is the chart."),
    () => ({ text: "The chart is above." }),
  );
  const response = await page.goto("/assistant?run=new");
  // The page policy the frame inherits, as served: what the checks below rest on.
  expect(response!.headers()["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
  expect(response!.headers()["content-security-policy"]).toContain("style-src 'self' 'unsafe-inline'");
  const chat = page.getByRole("region", { name: "Stem", exact: true });
  const box = chat.getByLabel("Message", { exact: true });
  await box.fill("Chart my week.");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  // The reference reaches the open chat: a card, and nothing of the code rendered.
  await expect(chat.getByText("The chart is above.", { exact: true })).toBeVisible();
  const card = chat.getByRole("region", { name: "Weekly tasks", exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByText(/^HTML · /)).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(codeReads).toBe(0);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("chat-artifact-card.png"), animations: "disabled" });

  // Show code: the markup as literal text, creating no element.
  await card.getByRole("button", { name: "Show code", exact: true }).click();
  await expect(card.locator("pre")).toContainText(`<script src="${PROBE}/script.js"></script>`);
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.locator("#probe-img, #out, #chart")).toHaveCount(0);
  await card.getByRole("button", { name: "Hide code", exact: true }).click();

  // Run asks first, and only then mounts the frame.
  await card.getByRole("button", { name: "Run", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Run this artifact?" });
  await expect(confirm).toContainText("send anything it holds outside Dispand");
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await card.getByRole("button", { name: "Run", exact: true }).click();
  await confirm.getByRole("button", { name: "Run", exact: true }).click();
  const frame = card.frameLocator("iframe");
  // The inline bootstrap and the artifact's inline script ran under the page policy; nothing reached out.
  await expect(frame.locator("#out")).not.toHaveText("pending");
  expect(JSON.parse((await frame.locator("#out").textContent())!)).toEqual({ external: "undefined", cookie: "SecurityError", storage: "SecurityError", parent: "SecurityError", rpc: "blocked" });
  await expect(frame.locator("#chart rect")).toHaveCount(5);
  expect(await card.locator("iframe").getAttribute("sandbox")).toBe("allow-scripts");
  await card.locator("iframe").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("chat-artifact-running.png"), animations: "disabled" });

  // Foreign messages, from the page itself or another frame, never reach the bridge.
  await page.evaluate(() => {
    const ask = { jsonrpc: "2.0", id: 1, method: "ui/message", params: { role: "user", content: [{ type: "text", text: "FOREIGN" }] } };
    window.postMessage({ type: "genframe:ready" }, "*");
    window.postMessage(ask, "*");
    const other = document.createElement("iframe");
    other.setAttribute("sandbox", "allow-scripts");
    other.srcdoc = `<script>parent.postMessage({ type: "genframe:ready" }, "*"); parent.postMessage(${JSON.stringify(ask)}, "*");</script>`;
    document.body.appendChild(other);
  });
  await page.waitForTimeout(500);
  await expect(box).toHaveValue("");
  // The artifact's own prompt goes to the draft, which the owner still sends.
  await frame.locator("#ask").click();
  await expect(box).toHaveValue("Draw it bigger");
  expect(model!.requests).toHaveLength(before + 2);
  // Links: http is refused, https only after the owner sees the address.
  await frame.locator("#plain").click();
  await page.waitForTimeout(300);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await frame.locator("#docs").click();
  const link = page.getByRole("dialog", { name: "Open this link?" });
  await expect(link).toContainText("https://example.org/guide");
  await link.getByRole("button", { name: "Cancel", exact: true }).click();
  // Navigating the frame elsewhere is blocked (the page's frame-src): the probe below is never reached.
  await frame.locator("#leave").click();
  await page.waitForTimeout(1000);

  // The page policy alone, without Generative Frame's: external scripts, stylesheets and images still don't load; inline scripts run.
  await page.evaluate((probe) => {
    const bare = document.createElement("iframe");
    bare.id = "bare";
    bare.setAttribute("sandbox", "allow-scripts");
    bare.srcdoc = `<link rel="stylesheet" href="${probe}/bare.css"><img src="${probe}/bare.png"><script src="${probe}/bare.js"></script><p id="ran">no</p><script>document.getElementById("ran").textContent = typeof window.probeLoaded === "undefined" ? "inline only" : "external";</script>`;
    document.body.appendChild(bare);
  }, PROBE);
  await expect(page.frameLocator("#bare").locator("#ran")).toHaveText("inline only");
  await page.waitForTimeout(500);
  expect(reached).toEqual([]);
  // The probe host would have answered: a page that may load it does.
  const control = await context.newPage();
  await control.goto(`${PROBE}/control`);
  expect(reached).toEqual([`${PROBE}/control`]);
  await control.close();

  // From history: the card again, nothing run, no tool call; Run renders the stored code.
  const runId = new URL(page.url()).searchParams.get("run")!;
  const shown = async () => (await rpc<{ rows: { details: { tool?: string } }[] }>(page, "audit/list", { jobId: runId, action: "platform.call" })).rows.filter((entry) => entry.details.tool === "artifact_show");
  expect(await shown()).toHaveLength(1);
  await page.reload();
  await expect(card).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await card.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("dialog", { name: "Run this artifact?" }).getByRole("button", { name: "Run", exact: true }).click();
  await expect(frame.locator("#chart rect")).toHaveCount(5);
  expect(model!.requests).toHaveLength(before + 2);
  expect(await shown()).toHaveLength(1);
});

// An artifact that reads the theme the host passes it, and says again when it changes.
const THEMED = `<style>body{margin:0;padding:16px;font-family:var(--font-sans);color:var(--color-text)}p{color:var(--color-text-muted)}</style>
<h3 style="margin:0 0 8px">Tasks done this week</h3>
<svg width="320" height="120" role="img" aria-label="Bar chart">${[3, 5, 2, 6, 4].map((n, i) => `<rect x="${i * 60 + 10}" y="${110 - n * 16}" width="40" height="${n * 16}" fill="var(--color-accent)"/>`).join("")}</svg>
<p id="scheme">pending</p>
<script>
  const show = () => { document.getElementById("scheme").textContent = document.documentElement.dataset.theme + " " + getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim(); };
  show();
  window.addEventListener("themechange", show);
</script>`;

test("a running artifact expands to most of the window, follows the theme, and collapses back to its button", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.emulateMedia({ colorScheme: "light" });
  await signIn(page);
  model!.script(use("artifact_show", { title: "Weekly tasks", format: "html", code: THEMED }, "Here is the chart."), () => ({ text: "The chart is above." }));
  await page.goto("/assistant?run=new");
  const chat = page.getByRole("region", { name: "Stem", exact: true });
  await chat.getByLabel("Message", { exact: true }).fill("Chart my week again.");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  const card = chat.getByRole("region", { name: "Weekly tasks", exact: true });
  await expect(card).toBeVisible();

  // Nothing to expand before Run, not even after Run was refused.
  const expand = card.getByRole("button", { name: "Expand", exact: true });
  await expect(expand).toHaveCount(0);
  await card.getByRole("button", { name: "Run", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Run this artifact?" });
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(expand).toHaveCount(0);
  await card.getByRole("button", { name: "Run", exact: true }).click();
  await confirm.getByRole("button", { name: "Run", exact: true }).click();
  await expect(expand).toBeVisible();
  await expect(card.locator("iframe")).toHaveCount(1);

  // Expanded: one frame, in the dialog, filling most of the window, in the app's light theme.
  const expanded = page.getByRole("dialog", { name: "Weekly tasks", exact: true });
  const frame = expanded.frameLocator("iframe");
  const open = async () => {
    await expand.click();
    await expect(expanded).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(1);
    await expect(card.locator("iframe")).toHaveCount(0);
    await expect(frame.locator("#scheme")).not.toHaveText("pending");
    const height = (await expanded.locator("iframe").boundingBox())!.height;
    expect(height).toBeGreaterThan(page.viewportSize()!.height * 0.75);
  };
  await open();
  await expect(frame.locator("#scheme")).toHaveText("light #fbfdf8");
  await expect(expanded).toContainText("Generated by the agent. Don't enter passwords or secrets in it.");
  await page.screenshot({ path: testInfo.outputPath("chat-artifact-expanded-light-desktop.png"), animations: "disabled" });

  // The theme changes under a running frame: it is told, and shows it.
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await expect(frame.locator("#scheme")).toHaveText("dark #1c1c1e");
  await page.screenshot({ path: testInfo.outputPath("chat-artifact-expanded-dark-desktop.png"), animations: "disabled" });

  // Esc collapses it, the focus goes back to Expand, and the frame is inline again.
  await page.keyboard.press("Escape");
  await expect(expanded).toHaveCount(0);
  await expect(expand).toBeFocused();
  await expect(page.locator("iframe")).toHaveCount(1);
  await expect(card.locator("iframe")).toHaveCount(1);
  await expect(card.frameLocator("iframe").locator("#scheme")).toHaveText("dark #1c1c1e");

  // A phone's width, in both themes; Collapse closes it too.
  await page.setViewportSize({ width: 390, height: 800 });
  await open();
  await expect(frame.locator("#scheme")).toHaveText("dark #1c1c1e");
  await page.screenshot({ path: testInfo.outputPath("chat-artifact-expanded-dark-phone.png"), animations: "disabled" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await expect(frame.locator("#scheme")).toHaveText("light #fbfdf8");
  await page.screenshot({ path: testInfo.outputPath("chat-artifact-expanded-light-phone.png"), animations: "disabled" });
  await expanded.getByRole("button", { name: "Collapse", exact: true }).click();
  await expect(expanded).toHaveCount(0);
  await expect(expand).toBeFocused();
});
