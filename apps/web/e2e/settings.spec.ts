import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { FakeRunner } from "./fake-runner.ts";

const SERVER = "http://localhost:3100";

/** Creates the owner when the app is fresh, otherwise signs in as them (auth.spec.ts may have run first). */
async function signIn(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/(setup|login)$/);
  await page.waitForLoadState("networkidle");
  if (page.url().endsWith("/setup")) {
    await page.getByLabel("Name").fill("Ada");
    await page.getByLabel("Setup code").fill("dev-setup-code-0123456789");
    await page.getByLabel("Email").fill("ada@example.com");
    await page.getByLabel("Password").fill("correct horse battery");
    await page.getByRole("button", { name: "Create account" }).click();
  } else {
    await page.getByLabel("Email").fill("ada@example.com");
    await page.getByLabel("Password").fill("correct horse battery");
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  // Home, or the Assistant's page until the first test has started it.
  await expect(page).toHaveURL(/\/(assistant)?$/);
}

// One owner for the file (the first test runs setup); tests run in order against the same app.
test.describe.configure({ mode: "serial" });

let runner: FakeRunner | undefined;
test.afterAll(() => runner?.close());

test("empty states, then a runner pairs, a harness goes online and an agent is created", async ({ page }) => {
  await signIn(page);

  await page.goto("/settings/agents");
  await expect(page.getByText("No agent yet")).toBeVisible();
  await expect(page.getByRole("link", { name: "Add a harness first" })).toBeVisible();

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Harnesses" }).click();
  await expect(page.getByText("No harness yet")).toBeVisible();
  await page.getByRole("button", { name: "New harness" }).click();

  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: /^CLI/ }).click();
  await sheet.getByLabel("Name").fill("Claude on Workstation");
  await sheet.getByLabel("Runner").click();
  await page.getByRole("option", { name: "Add a runner…" }).click();
  await sheet.getByLabel("Runner name").fill("Workstation");
  await sheet.getByRole("button", { name: "Get the install command" }).click();

  const command = await sheet.getByLabel("Install command").innerText();
  expect(command).toContain("/runner/install.sh");
  const code = /DISPAND_PAIRING_CODE=([A-Z0-9]{8})/.exec(command)?.[1];
  expect(code).toBeTruthy();
  await expect(sheet.getByText("Waiting for the runner to come online")).toBeVisible();

  runner = await FakeRunner.pair(SERVER, code!.toLowerCase());

  // The sheet notices the runner (polling every 2 s) and goes back to the form with it selected.
  await expect(sheet.getByLabel("Runner", { exact: true })).toContainText("Workstation", { timeout: 15_000 });
  await sheet.getByRole("button", { name: "Create harness" }).click();

  const row = page.getByRole("button", { name: /Claude on Workstation/ });
  await expect(row).toContainText("Claude Code 2.1.0 on Workstation");
  await expect(row).toContainText("Online");

  await page.getByRole("link", { name: "Create an agent" }).click();
  await expect(page).toHaveURL(/\/settings\/agents\/new\?harness=harness_/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Name").fill("Writer");
  await expect(page.getByLabel("Harness")).toContainText("Claude on Workstation");
  await page.getByLabel("System prompt").fill("You write short, clear notes.");
  await page.getByRole("button", { name: "Create agent" }).click();
  // A new agent goes back to the list, which offers the next step.
  await expect(page).toHaveURL(/\/settings\/agents\?saved=true$/);
  await expect(page.getByRole("link", { name: "Configure a manual workflow" })).toBeVisible();

  await page.getByRole("link", { name: /Writer/ }).click();
  await expect(page.getByLabel("System prompt")).toHaveValue("You write short, clear notes.");
  // Saving an edit shows the banner in room kept for it: the form doesn't move.
  // At the narrowest supported width, where the banner wraps. In page coordinates: clicking
  // Save may scroll the page.
  await page.setViewportSize({ width: 360, height: 740 });
  const top = () => page.getByLabel("Name").evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  const before = await top();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Agent saved.")).toBeVisible();
  expect(await top()).toBe(before);

  // An install set up before the Assistant: Home sends the owner to start it, on a harness they pick.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page).toHaveURL(/\/assistant$/);
  await page.waitForLoadState("networkidle");
  await page.getByRole("combobox", { name: "Harness" }).selectOption({ label: "Claude on Workstation" });
  await page.getByRole("button", { name: "Start the Assistant" }).click();
  await expect(page.getByText("Describe your business or use case and how you'd like to automate it.")).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome, Ada" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("a harness used by an agent cannot be deleted; the status follows the runner", async ({ page }) => {
  await signIn(page);

  await page.goto("/settings/harnesses");
  const row = page.getByRole("button", { name: /Claude on Workstation/ });
  await row.click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("An agent uses this harness");
  await page.keyboard.press("Escape");

  runner?.close();
  await expect(row).toContainText("Offline", { timeout: 15_000 });
});

test("the Runners tab adds, renames and deletes runners, and keeps a runner a harness uses", async ({ page }) => {
  await signIn(page);

  await page.goto("/settings/harnesses");
  await page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: "Runners" }).click();
  await expect(page).toHaveURL(/\/settings\/harnesses\/runners$/);
  await expect(page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: "Runners" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Harnesses" })).toHaveAttribute("aria-current", "page");

  // Workstation still runs the harness: deleting it is refused, after a confirmation.
  await page.getByRole("button", { name: /Workstation/ }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Delete" }).click();
  await sheet.getByRole("button", { name: "Delete runner" }).click();
  await expect(sheet.getByRole("alert")).toContainText("A harness uses this runner. Delete or move the harness first.");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Add runner" }).click();
  await sheet.getByLabel("Runner name").fill("Laptop");
  await sheet.getByRole("button", { name: "Get the install command" }).click();
  const code = /DISPAND_PAIRING_CODE=([A-Z0-9]{8})/.exec(await sheet.getByLabel("Install command").innerText())?.[1];
  const laptop = await FakeRunner.pair(SERVER, code!);
  try {
    // The sheet closes once the runner is online.
    await expect(sheet).toBeHidden({ timeout: 15_000 });
    const row = page.getByRole("button", { name: /Laptop/ });
    await expect(row).toContainText("Claude Code 2.1.0");
    await expect(row).toContainText("Online", { timeout: 15_000 });

    await row.click();
    await sheet.getByLabel("Runner name").fill("Spare");
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet).toBeHidden();
    await page.getByRole("button", { name: /Spare/ }).click();
    await sheet.getByRole("button", { name: "Delete" }).click();
    await sheet.getByRole("button", { name: "Delete runner" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: /Spare/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Workstation/ })).toBeVisible();
  } finally {
    laptop.close();
  }
});

test("a cloud harness lists its provider's models, and its key is never shown again", async ({ page }) => {
  const key = "sk-e2e-0123456789abcdef";
  // A stand-in OpenAI-compatible server: it lists one model for the right key.
  const stub = createServer((req, res) => {
    const ok = req.url === "/v1/models" && req.headers.authorization === `Bearer ${key}`;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { data: [{ id: "local-model" }] } : { error: `bad key ${req.headers.authorization}` }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const { port } = stub.address() as AddressInfo;
  try {
    await signIn(page);
    await page.goto("/settings/harnesses");
    await page.getByRole("button", { name: "New harness" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: /^Cloud/ }).click();
    await sheet.getByLabel("Name").fill("Local LLM");
    await sheet.getByLabel("Provider").click();
    await page.getByRole("option", { name: "OpenAI-compatible" }).click();
    await sheet.getByLabel("Base URL").fill(`http://127.0.0.1:${port}/v1`);
    await sheet.getByLabel("API key (optional)").fill(key);
    await sheet.getByLabel("Name").click();
    await sheet.getByLabel("Model").click();
    await page.getByRole("option", { name: "local-model" }).click();
    await sheet.getByRole("button", { name: "Create harness" }).click();

    const row = page.getByRole("button", { name: /Local LLM/ });
    await expect(row).toContainText("OpenAI-compatible · local-model");
    await page.reload();
    await expect(page.getByRole("button", { name: /Local LLM/ })).toBeVisible();
    expect(await page.content()).not.toContain(key);
    await page.getByRole("button", { name: /Local LLM/ }).click();
    const keyField = page.getByRole("dialog").getByLabel("API key (optional)");
    await expect(keyField).toHaveValue("");
    await expect(keyField).toHaveAttribute("placeholder", "Set: leave empty to keep");
  } finally {
    stub.close();
  }
});

test("a Codex harness shows its runner's Codex version and sign-in, and only Codex's permission modes", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/harnesses");
  await page.getByRole("button", { name: "New harness" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: /^CLI/ }).click();
  await sheet.getByLabel("Name").fill("Codex on Workstation");
  await sheet.getByLabel("CLI").click();
  await page.getByRole("option", { name: "Codex" }).click();
  await sheet.getByLabel("Runner").click();
  await page.getByRole("option", { name: "Add a runner…" }).click();
  await sheet.getByLabel("Runner name").fill("Workstation");
  await sheet.getByRole("button", { name: "Get the install command" }).click();
  const code = /DISPAND_PAIRING_CODE=([A-Z0-9]{8})/.exec(await sheet.getByLabel("Install command").innerText())?.[1];
  const workstation = await FakeRunner.pair(SERVER, code!, { claude: "2.1.0", codex: { version: "0.166.0", signedIn: false } });
  try {
    await expect(sheet.getByLabel("Runner", { exact: true })).toContainText("Workstation", { timeout: 15_000 });
    await expect(sheet).toContainText("Codex 0.166.0. Not signed in: run `codex login` on Workstation", { timeout: 15_000 });

    await sheet.getByLabel("Permissions").click();
    await expect(page.getByRole("option")).toHaveText(["Ask before acting", "Bypass permissions"]);
    await page.keyboard.press("Escape");
    await sheet.getByRole("button", { name: "Create harness" }).click();

    const row = page.getByRole("button", { name: /Codex on Workstation/ });
    await expect(row).toContainText("Codex 0.166.0 on Workstation · Ask before acting");
    await row.click();
    await sheet.getByRole("button", { name: "Delete" }).click();
    await expect(row).toHaveCount(0);
  } finally {
    workstation.close();
  }
});
