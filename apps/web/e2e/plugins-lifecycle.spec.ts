import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { expect as baseExpect, test, type Page } from "@playwright/test";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

// The plugin lifecycle's acceptance, on the law-firm fixture: install with its definitions, override
// an agent, update from a new commit (a conflict, a widening change, a table field, a wording change),
// uninstall keeping the overridden agent, then run a Job of it. Cloud harness on a scripted model.
const WAIT_MS = 20_000;
const expect = baseExpect.configure({ timeout: WAIT_MS });
test.describe.configure({ timeout: 180_000 });

let model: FakeModel | undefined;
test.afterAll(() => model?.close());

async function signIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/(assistant)?$/);
}

async function rpc<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const res = await page.request.post(`/api/rpc/${path}`, { headers: { "x-csrf-token": "orpc" }, data: input === undefined ? {} : { json: input } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { json: T }).json;
}

const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env });

/** A local Git repository holding `files`: committed again by each call to the returned function. */
function repo(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  const commit = (more: Record<string, string>) => {
    for (const [path, content] of Object.entries(more)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git(dir, "add", ...Object.keys(more));
    git(dir, "commit", "-q", "-m", "fixture");
  };
  commit(files);
  return { url: pathToFileURL(dir).href, commit };
}

/** The law-firm fixture's files, as the domain tests build their plugin. */
function lawFirm(): Record<string, string> {
  const root = join(import.meta.dirname, "../../../packages/domain/src/plugins/fixtures/law-firm");
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => [relative(root, join(d.parentPath, d.name)), readFileSync(join(d.parentPath, d.name), "utf8")]),
  );
}

test("install a plugin with its definitions, override an agent, update, uninstall keeping it, run it", async ({ page }) => {
  model = await startFakeModel("lifecycle-model");
  const dir = mkdtempSync(join(tmpdir(), "dispand-lifecycle-"));
  const files = lawFirm();
  const plugin = repo(join(dir, "plugin"), files);
  const market = repo(join(dir, "market"), { ".claude-plugin/marketplace.json": JSON.stringify({ name: "firms", plugins: [{ name: "law-firm", source: { source: "url", url: plugin.url } }] }) });

  await signIn(page);
  // What earlier specs left: kept as it is when this one cleans up after itself.
  const ids = async (path: string, key = "id") => new Set((await rpc<Record<string, string>[]>(page, path)).map((x) => x[key]!));
  const before = { agents: await ids("agents/list"), tables: await ids("tables/list"), skills: await ids("skills/list", "packageId"), tools: await ids("tools/list") };
  // The agents of the plugin are written for a cloud harness; this app has none yet (settings.spec.ts makes its own later).
  const harness = await rpc<{ id: string }>(page, "harnesses/create", { type: "cloud", name: "Lifecycle model", kind: "openai-compatible", baseUrl: model.baseUrl, model: "lifecycle-model", systemPrompt: "" });

  // 1. Add the marketplace and install the plugin with its definitions.
  await page.goto("/settings/plugins");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Marketplace Git URL").fill(market.url);
  await page.getByRole("button", { name: "Add marketplace" }).click();
  await expect(page.getByRole("button", { name: "Remove firms" })).toBeVisible();
  await page.getByRole("button", { name: "Install law-firm" }).click();
  const sheet = page.getByRole("dialog");
  for (const table of ["Clients", "Matters", "Research"]) await expect(sheet.getByRole("checkbox", { name: new RegExp(`^${table} Not set up`) })).toBeChecked();
  for (const agent of ["Drafting", "Matter upkeep", "Intake and research"]) {
    await expect(sheet.getByRole("checkbox", { name: new RegExp(`^${agent} `) })).toBeChecked();
    await expect(sheet.getByLabel(`Harness of ${agent}`)).toContainText("Lifecycle model");
  }
  await expect(sheet.getByRole("list", { name: "What Drafting may do" })).toContainText("Tools: catalog:gmail");
  await expect(sheet.getByRole("checkbox", { name: /^New client email/ })).toBeChecked();
  // Its server is ticked once its URL is seen, so that "Intake and research" has its tool.
  await expect(sheet.getByText("https://case-law.example.com/mcp")).toBeVisible();
  await sheet.getByRole("checkbox", { name: /case-law/ }).check();
  // No CLI harness here to install the native plugin on.
  await sheet.getByRole("checkbox", { name: /Install the complete native plugin/ }).uncheck();
  await sheet.getByRole("button", { name: "Install" }).click();
  // A poll trigger runs a tool the install doesn't grant: it waits for its owner, and the rest is made.
  await expect(sheet.getByRole("list", { name: "Not made yet" })).toContainText("New client email: Its poll runs");
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole("link", { name: "Installed", exact: true }).click();
  const row = page.getByRole("listitem", { name: "law-firm" });
  await expect(row).toContainText("From firms");

  // 2. Override Drafting's instructions.
  await page.goto("/settings/agents");
  await page.getByRole("link", { name: /Drafting/ }).click();
  await expect(page.getByText("It is law-firm's.", { exact: false })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const mine = "Draft the reply in our firm's tone, signed by the partner.";
  await page.getByLabel("System prompt").fill(mine);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Instructions: yours, kept through updates")).toBeVisible();
  const drafting = page.url();

  // 3. A second commit: Drafting reworded, another agent's description reworded, a tool added, a field added.
  const next = { ...files };
  next["com.dispand/agents/drafting.md"] = files["com.dispand/agents/drafting.md"]!.replace("Draft the reply to the client from the research recorded, as a draft in the mailbox.", "Write the client's reply from the research recorded, and leave it as a draft.");
  next["com.dispand/agents/matter-upkeep.md"] = files["com.dispand/agents/matter-upkeep.md"]!.replace("Keeps each matter's conclusions up to date.", "Keeps every matter's conclusions current.").replace("tables: [Matters]", 'tools: ["catalog:gmail"]\ntables: [Matters]');
  next["com.dispand/primitives/clients.json"] = JSON.stringify({ name: "Clients", primitive: true, fields: [{ name: "Email", type: "text" }, { name: "Phone", type: "text" }] });
  const changed = Object.fromEntries(Object.entries(next).filter(([path, text]) => text !== files[path]));
  expect(Object.keys(changed)).toHaveLength(3);
  plugin.commit(changed);
  await page.goto("/settings/plugins/installed");

  // 4. The update screen shows it all at once. Keep the owner's instructions.
  await page.getByRole("button", { name: "Update law-firm" }).click();
  const update = page.getByRole("dialog");
  const conflict = update.getByRole("group", { name: "Drafting: Instructions" });
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText(mine);
  for (const choice of ["Keep mine", "Take the plugin's", "Let Stem deal with it"]) await expect(conflict.getByRole("radio", { name: choice })).toBeVisible();
  await expect(conflict.getByRole("radio", { name: "Keep mine" })).toBeChecked();
  await expect(update.getByRole("list", { name: "Changes that give more" })).toHaveText("Matter upkeep · Tools: none → Gmail");
  await expect(update.getByRole("group", { name: "Clients" }).getByRole("checkbox", { name: "Add the field Phone" })).toBeChecked();
  const wording = update.getByText(/^\d+ wording changes?$/);
  await expect(wording).toBeVisible();
  await expect(update.getByText("Keeps every matter's conclusions current.")).toBeHidden();
  await conflict.getByRole("radio", { name: "Keep mine" }).check();
  await update.getByRole("button", { name: "Update", exact: true }).click();
  await expect(update).toBeHidden();

  await page.goto(drafting);
  await expect(page.getByLabel("System prompt")).toHaveValue(mine);
  await page.goto("/settings/data");
  await page.getByRole("link", { name: /Clients/ }).first().click();
  await expect(page.getByRole("columnheader", { name: "Phone" })).toBeVisible();

  // 5. Uninstall, keeping Drafting: what it needs is listed under it, the rest goes.
  await page.goto("/settings/plugins/installed");
  await page.getByRole("button", { name: "Remove law-firm" }).click();
  const removal = page.getByRole("dialog");
  await expect(removal.getByRole("group", { name: "Drafting" })).toBeVisible();
  // Drafting consults "Intake and research", so keeping Drafting keeps it, and what that one needs.
  await expect(removal.getByRole("group", { name: "Intake and research" })).toContainText("Needed by Drafting if you keep it");
  await expect(removal.getByRole("group", { name: "Matter upkeep" })).toHaveCount(0);
  await expect(removal.getByText(/other elements? go(es)? with the plugin/)).toBeVisible();
  await removal.getByRole("button", { name: "Remove plugin" }).click();
  await expect(page.getByText("No plugin installed")).toBeVisible();

  await page.goto("/settings/agents");
  await expect(page.getByRole("link", { name: /Drafting/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Matter upkeep/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Intake and research/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /law-firm/ })).toHaveCount(0);
  await page.getByRole("link", { name: /Drafting/ }).click();
  await expect(page.getByLabel("System prompt")).toHaveValue(mine);
  await expect(page.getByText("It is law-firm's.", { exact: false })).toHaveCount(0);

  // 6. The kept agent still runs a Job.
  const agents = await rpc<{ id: string; name: string }[]>(page, "agents/list");
  const kept = agents.find((a) => a.name === "Drafting")!;
  const trigger = await rpc<{ id: string }>(page, "triggers/create", { agentId: kept.id, name: "Draft now", instructions: "Draft the reply.", config: { kind: "manual", placement: "button" } });
  model.script(() => ({ text: "Drafted." }));
  const { runId } = await rpc<{ runId: string }>(page, "jobs/start", { triggerId: trigger.id });
  await expect.poll(async () => (await rpc<{ status: string }>(page, "jobs/get", { id: runId })).status).toBe("succeeded");
  expect(model.requests[0]![0]!.content).toContain(mine);

  // Leave the app as the next specs expect it: what this spec made goes (only that), with its harness and marketplace.
  for (const a of await rpc<{ id: string }[]>(page, "agents/list")) if (!before.agents.has(a.id)) await rpc(page, "agents/delete", { id: a.id });
  // A table another refers to goes after it: the tables stand in the order of their references.
  const made = async () => (await rpc<{ id: string }[]>(page, "tables/list")).filter((t) => !before.tables.has(t.id));
  for (let left = await made(); left.length; left = await made()) {
    const res = await page.request.post("/api/rpc/tables/delete", { headers: { "x-csrf-token": "orpc" }, data: { json: { id: left.at(-1)!.id } } });
    expect(res.status(), `tables/delete: ${await res.text()}`).toBe(200);
  }
  for (const k of await rpc<{ packageId: string }[]>(page, "skills/list")) if (!before.skills.has(k.packageId)) await rpc(page, "skills/delete", { packageId: k.packageId });
  for (const t of await rpc<{ id: string }[]>(page, "tools/list")) if (!before.tools.has(t.id)) await rpc(page, "tools/delete", { id: t.id });
  await rpc(page, "harnesses/delete", { id: harness.id });
  await page.goto("/settings/plugins");
  await page.getByRole("button", { name: "Remove firms" }).click();
  await expect(page.getByRole("button", { name: "Remove firms" })).toBeHidden();
});
