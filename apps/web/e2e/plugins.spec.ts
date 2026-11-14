import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/** Signs in as the owner created by auth.spec.ts. */
async function signIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Home, or the Assistant's page before settings.spec.ts has started it.
  await expect(page).toHaveURL(/\/(assistant)?$/);
}

async function shots(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: test.info().outputPath(`${name}-light.png`), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath(`${name}-dark.png`), animations: "disabled" });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.screenshot({ path: test.info().outputPath(`${name}-phone-dark.png`), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath(`${name}-phone-light.png`), animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
}

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n`;

/** A local marketplace repository (the dev server takes file:// URLs for e2e only). */
function marketplaceRepo(dir: string): string {
  const files: Record<string, string> = {
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "acme-plugins",
      plugins: [
        { name: "writing-kit", description: "Skills for clear writing and reviews.", source: "./plugins/writing-kit" },
        { name: "npm-helper", description: "Published on npm.", source: { source: "npm", package: "@acme/helper" } },
      ],
    }),
    "plugins/writing-kit/.claude-plugin/plugin.json": JSON.stringify({ name: "writing-kit" }),
    "plugins/writing-kit/skills/plain-words/SKILL.md": skill("plain-words", "Use when writing for people: short sentences, plain words."),
    "plugins/writing-kit/skills/review-notes/SKILL.md": skill("review-notes", "Use when reviewing a draft: notes by severity."),
    "plugins/writing-kit/hooks/hooks.json": JSON.stringify({ hooks: { SessionStart: [] } }),
    "plugins/writing-kit/.mcp.json": JSON.stringify({
      mcpServers: { docs: { type: "http", url: "https://docs.example/mcp", headers: { "X-Key": "${DOCS_KEY}" } }, fetch: { command: "uvx", args: ["mcp-server-fetch"] } },
    }),
    "plugins/writing-kit/agents/editor.md": "---\nname: editor\ndescription: Edits drafts.\n---\n\nYou edit drafts.\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) execFileSync("git", args, { cwd: dir, env });
  return pathToFileURL(dir).href;
}

test("add a marketplace, install a plugin's skills, see them in Skills and Installed, then remove it", async ({ page }) => {
  // Four sets of screenshots, and the first visit compiles the plugin pages.
  test.setTimeout(120_000);
  const url = marketplaceRepo(test.info().outputPath("marketplace"));
  await signIn(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Plugins" }).click();
  await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();
  await expect(page.getByText("No plugin yet")).toBeVisible();
  await expect(page.getByText("https://github.com/anthropics/claude-plugins-official.git")).toBeVisible();
  await page.waitForLoadState("networkidle");

  await page.getByLabel("Marketplace Git URL").fill("http://example.com/plugins.git");
  await page.getByRole("button", { name: "Add marketplace" }).click();
  await expect(page.getByRole("alert")).toContainText("Use an https:// Git URL");
  await page.getByLabel("Marketplace Git URL").fill(url);
  await page.getByRole("button", { name: "Add marketplace" }).click();
  await expect(page.getByRole("button", { name: "Remove acme-plugins" })).toBeVisible();
  await expect(page.getByText(/^2 plugins · synced/)).toBeVisible();
  await expect(page.getByText("Unsupported source: “npm” sources aren't supported")).toBeVisible();
  await page.getByLabel("Search plugins").fill("writing");
  await expect(page.getByRole("button", { name: /^Install / })).toHaveCount(1);
  await page.mouse.move(0, 0);
  await shots(page, "slice-4-task-8-discover");

  // Native clients are simulated here; the domain and pinned CLI tests cover their actual contract.
  const nativeTargets = [
    { id: "native-claude", ownerId: "owner", type: "cli", name: "Claude Code", runnerId: "native-runner", kind: "claude-code", permissionMode: "default" },
    { id: "native-codex", ownerId: "owner", type: "cli", name: "Codex", runnerId: "native-runner", kind: "codex", permissionMode: "default" },
  ];
  const nativeRequests: { harnessIds: string[]; dryRun: boolean; revision?: string }[] = [];
  let finishNative!: () => void;
  const installing = new Promise<void>((resolve) => { finishNative = resolve; });
  await page.route("**/api/rpc/harnesses/list", (route) => route.fulfill({ json: { json: nativeTargets } }));
  await page.route("**/api/rpc/runners/list", (route) => route.fulfill({ json: { json: [{ id: "native-runner", name: "Workstation", status: "online", runnerUpdate: "current", clis: {}, tools: [], lastSeenAt: null }] } }));
  await page.route("**/api/rpc/runners/plugins", (route) => route.fulfill({ json: { json: { targets: nativeTargets.map((h) => ({ harness: h.kind, available: true, add: true, remove: true })) } } }));
  await page.route("**/api/rpc/runners/workspacePlugin", async (route) => {
    const input = route.request().postDataJSON().json;
    nativeRequests.push(input);
    if (!input.dryRun) await installing;
    await route.fulfill({ json: { json: input.dryRun ? { revision: "native-preview", blocked: false } : { results: nativeTargets.map((h) => ({ name: "writing-kit", harness: h.kind, status: "installed" })) } } });
  });

  await page.getByRole("button", { name: "Install writing-kit" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("checkbox", { name: /plain-words/ })).toBeChecked();
  // A server is ticked only once its URL is seen.
  await expect(sheet.getByRole("checkbox", { name: /docs/ })).not.toBeChecked();
  await expect(sheet.getByText("https://docs.example/mcp")).toBeVisible();
  await sheet.getByRole("checkbox", { name: /docs/ }).check();
  await expect(sheet.getByLabel("DOCS_KEY")).toHaveAttribute("type", "password");
  await expect(sheet.getByRole("checkbox", { name: /fetch/ })).toBeDisabled();
  await expect(sheet.getByText("Runs a command on a machine: not yet supported")).toBeVisible();
  await expect(sheet.getByRole("checkbox", { name: /editor/ })).toBeChecked();
  await expect(sheet.getByLabel("Harness", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Hooks run commands on the machine")).toBeVisible();
  await sheet.getByLabel("DOCS_KEY").fill("docs-key-value");
  await shots(page, "slice-4-task-13-install");
  // No harness to run the agent on in this test: leave it out.
  await sheet.getByRole("checkbox", { name: /editor/ }).uncheck();
  await expect(sheet.getByLabel("Harness", { exact: true })).toBeHidden();
  await sheet.getByRole("checkbox", { name: /review-notes/ }).uncheck();
  await expect(sheet.getByRole("checkbox", { name: /Install the complete native plugin/ })).toBeChecked();
  await expect(sheet.getByRole("checkbox", { name: /Workstation \/ Claude Code/ })).toBeChecked();
  await expect(sheet.getByRole("checkbox", { name: /Workstation \/ Codex/ })).toBeChecked();
  await sheet.getByRole("button", { name: "Install" }).click();
  const progress = sheet.getByRole("list", { name: "Native installations" });
  await expect(progress.getByRole("status")).toHaveText(["Installing…", "Installing…"]);
  await expect(sheet.getByRole("button", { name: "Apply native install" })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("native-installing.png"), animations: "disabled" });
  finishNative();
  await expect(progress.getByRole("status")).toHaveText(["Installed", "Installed"]);
  expect(nativeRequests.map((input) => ({ harnessIds: input.harnessIds, dryRun: input.dryRun, revision: input.revision }))).toEqual([
    { harnessIds: ["native-claude", "native-codex"], dryRun: true, revision: undefined },
    { harnessIds: ["native-claude", "native-codex"], dryRun: false, revision: "native-preview" },
  ]);
  await shots(page, "native-installed");
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText("Installed", { exact: true }).last()).toBeVisible();

  await page.getByRole("link", { name: "Installed", exact: true }).click();
  const row = page.getByRole("listitem", { name: "writing-kit" });
  await expect(row).toContainText("From acme-plugins");
  await expect(row).toContainText("plain-words");
  await expect(row).toContainText("review-notes (skill)");
  await expect(row).toContainText("Tools: docs");
  await expect(row).toContainText("editor (agent)");
  await page.mouse.move(0, 0);
  await shots(page, "slice-4-task-13-installed");

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Tools" }).click();
  // A plugin's tool is listed under its plugin's name.
  await expect(page.getByRole("button", { name: /^writing-kit\/docs/ })).toBeVisible();

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Skills" }).click();
  await expect(page.getByRole("button", { name: /^writing-kit/ })).toContainText("From plugin writing-kit");
  await expect(page.getByText("Read-only")).toBeVisible();

  // Removing it takes its skill package, which no agent uses, and keeps its tool, then the
  // owner's own: deleted here, since skills.spec.ts and tools.spec.ts start from empty lists.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Plugins" }).click();
  await page.getByRole("link", { name: "Installed", exact: true }).click();
  await expect(row).toContainText("Choose what to remove; items you keep stay in your workspace");
  await page.getByRole("button", { name: "Remove writing-kit" }).click();
  const removal = page.getByRole("dialog");
  await expect(removal.getByRole("checkbox", { name: /writing-kit/ })).toBeChecked();
  await expect(removal.getByRole("checkbox", { name: /docs/ })).toBeChecked();
  await shots(page, "plugin-removal-checklist");
  await removal.getByRole("button", { name: "Remove plugin" }).click();
  await expect(page.getByText("No plugin installed")).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Skills" }).click();
  await expect(page.getByRole("button", { name: /^writing-kit/ })).toBeHidden();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Tools" }).click();
  await expect(page.getByRole("button", { name: /^docs/ })).toBeHidden();
  await expect(page.getByText("No tool yet")).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Plugins" }).click();
  await page.getByRole("link", { name: "Discover", exact: true }).click();
  await page.getByRole("button", { name: "Remove acme-plugins" }).click();
  await expect(page.getByRole("button", { name: "Remove acme-plugins" })).toBeHidden();
});

test("add a Git repository of skills: one entry, installed like a plugin, then removed", async ({ page }) => {
  test.setTimeout(120_000);
  const dir = test.info().outputPath("skill-repo");
  mkdirSync(join(dir, "skills/tidy-notes"), { recursive: true });
  writeFileSync(join(dir, "skills/tidy-notes/SKILL.md"), skill("tidy-notes", "Use when notes are messy: group, dedupe, date them."));
  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) execFileSync("git", args, { cwd: dir, env });

  await signIn(page);
  await page.goto("/settings/plugins");
  await page.waitForLoadState("networkidle");
  await expect(page.getByLabel("Kind of source")).toHaveValue("git");
  await page.getByLabel("Kind of source").selectOption("well-known");
  await expect(page.getByRole("button", { name: "Add skill site" })).toBeVisible();
  await page.getByLabel("Skill site address").fill("http://example.com");
  await page.getByRole("button", { name: "Add skill site" }).click();
  await expect(page.getByRole("alert")).toContainText("Use an https:// address");

  await page.getByLabel("Kind of source").selectOption("git");
  await page.getByLabel("Marketplace Git URL").fill(pathToFileURL(dir).href);
  await page.getByRole("button", { name: "Add marketplace" }).click();
  await expect(page.getByText("Skill repository")).toBeVisible();
  await expect(page.getByText(/^1 plugin · synced/)).toBeVisible();
  await page.mouse.move(0, 0);
  await shots(page, "slice-4-skill-sources-discover");

  await page.getByRole("button", { name: "Install skill-repo" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("checkbox", { name: /tidy-notes/ })).toBeChecked();
  await expect(sheet.getByRole("checkbox", { name: /Install the complete native plugin/ })).not.toBeChecked();
  await sheet.getByRole("button", { name: "Install" }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole("link", { name: "Installed", exact: true }).click();
  await expect(page.getByRole("listitem", { name: "skill-repo" })).toContainText("tidy-notes");
  await page.getByRole("button", { name: "Remove skill-repo" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove plugin" }).click();
  await expect(page.getByText("No plugin installed")).toBeVisible();
  await page.getByRole("link", { name: "Discover", exact: true }).click();
  await page.getByRole("button", { name: "Remove skill-repo" }).click();
  await expect(page.getByRole("button", { name: "Remove skill-repo" })).toBeHidden();
});
