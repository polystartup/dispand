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
  const res = await page.request.post(`/api/rpc/${path}`, { headers: { "x-csrf-token": "orpc" }, data: input === undefined ? {} : { json: input } });
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
  const chat = page.getByRole("region", { name: "Assistant" });
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
  await sheet.getByLabel("Model").click();
  await page.getByRole("option", { name: "scripted-model" }).click();
  await sheet.getByRole("button", { name: "Create harness" }).click();
  await expect(sheet).toHaveCount(0);
  await page.getByRole("button", { name: "Start the Assistant" }).click();
  const chat = page.getByRole("region", { name: "Assistant" });
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
    /* 16 */ { tool: "agents_update", input: { id: ids.assistant, name: "Assistant", harnessId: ids.cloud, systemPrompt: `How this firm works: ${DESCRIPTION}`, skillPackageIds: [ids.platformSkill], toolIds: [] } },
  ];
  model.script(
    use("propose", { items, plugin: "Law firm" }, "Ok, let me set this up in Dispand."),
    ask("Here is the setup I propose: client, matter and research tables, three agents, Gmail and a case-law search, and the triggers wiring them. Do you want to modify anything, or shall I go ahead?"),
    (m) => ({ call: { name: "proposal_apply", args: { proposalId: proposalOf(m) } } }),
    (m) => ({ call: { name: "tools_get", args: { id: lastResult<Applied>(m).items[7]!.id } } }),
    (m) => ({ text: `I have set up Dispand for you. How about you start by connecting your email account: [Gmail](${lastResult<{ signInPath: string }>(m).signInPath}).` }),
  );

  // 2. The description; the proposal is one Approval in the chat, every item shown.
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill(DESCRIPTION);
  await chat.getByRole("button", { name: "Send" }).click();
  await approve(page, items.length, ["Clients", "Matters", "Research", "Gmail", "Case law", "Intake and research", "Drafting", "Matter upkeep", "New client email", "Do you want to modify anything", "Runs without asking:", "Other enabled actions ask"]);

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
  for (const name of ["Assistant", "Intake and research", "Drafting", "Matter upkeep"]) await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
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

  // The description is kept in the Assistant's instructions, and the setup is one generated plugin.
  const assistant = await rpc<{ systemPrompt: string; skills: { packageId: string }[] }>(page, "agents/get", { id: ids.assistant });
  expect(assistant.systemPrompt).toContain(DESCRIPTION);
  expect(assistant.skills.map((s) => s.packageId)).toEqual([ids.platformSkill]);
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
  const chat = page.getByRole("region", { name: "Assistant" });
  const box = chat.getByRole("textbox", { name: "Message", exact: true });
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
    await page.getByRole("button", { name: "Assistant settings" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Harness", { exact: true }).click();
    await page.getByRole("option", { name: "Assistant settings CLI", exact: true }).click();
    await sheet.getByLabel("Model", { exact: true }).fill("sonnet");
    await sheet.getByRole("button", { name: "Save settings" }).click();
    await expect(sheet).toHaveCount(0);
    const chat = page.getByRole("region", { name: "Assistant", exact: true });
    await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Use the selected harness and model.");
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    const { start } = await settingsRunner.waitFor("session.start", WAIT_MS);
    expect(start.harness).toBe("claude-code");
    expect(start.model).toBe("sonnet");
    settingsRunner.emit(start.sessionId, { type: "text", delta: "Using your selected settings." });
    await expect(chat.getByText("Using your selected settings.")).toBeVisible();

    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await expect(chat.getByRole("textbox", { name: "Message", exact: true })).toBeInViewport();
      const bounds = (await chat.boundingBox())!;
      expect(bounds.x + bounds.width).toBeGreaterThan(viewport.width - 30);
      expect(bounds.y + bounds.height).toBeGreaterThan(viewport.height - 30);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
      expect(bounds.height).toBeGreaterThan(viewport.height * 0.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`assistant-${viewport.width}.png`) });
    }

    await page.reload();
    await page.getByRole("button", { name: "Assistant settings" }).click();
    await expect(sheet.getByLabel("Model", { exact: true })).toHaveValue("sonnet");
    await sheet.getByLabel("Model", { exact: true }).fill("");
    await sheet.getByRole("button", { name: "Save settings" }).click();
    await expect(sheet).toHaveCount(0);
    await page.getByRole("navigation", { name: "Conversations" }).getByRole("button", { name: "New conversation" }).click();
    await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Use the default model.");
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    expect((await settingsRunner.waitFor("session.start", WAIT_MS)).start.model).toBeUndefined();
  } finally {
    settingsRunner.close();
  }
});
