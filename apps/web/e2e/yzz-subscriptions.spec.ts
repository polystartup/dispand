import { expect, test, type Page } from "@playwright/test";
import { FakeRunner } from "./fake-runner.ts";

// After the specs that expect no agent, and before zz-questions (it counts the Inbox): this one adds a Job and leaves nothing pending.

async function signIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/(assistant)?$/);
}

/** Calls an API procedure as the signed-in owner (setup that has no screen worth driving). */
async function rpc<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const res = await page.request.post(`/api/rpc/${path}`, { maxRetries: 1, headers: { "x-csrf-token": "orpc" }, data: input === undefined ? {} : { json: input } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { json: T }).json;
}

let runner: FakeRunner | undefined;
test.afterAll(() => runner?.close());

// What the runner's supervisor reports for a Codex login; the same identity every time, or Dispand ends the enrollment.
const identity = `sha256:${"a".repeat(64)}`;
const codex = { version: "0.169.0", signedIn: true };
const reported = (signInNeeded: boolean) => ({ codex, subscriptions: [{ harness: "codex" as const, identity, signInNeeded }] });

test("a person enrolls their subscription from Settings, sees when it needs a fresh sign-in, and their own Job runs on it", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 1000 });
  await signIn(page);
  const created = await rpc<{ runnerId: string; pairingCode: string }>(page, "runners/create", { name: "Subscriber box" });
  runner = await FakeRunner.pair(page, created.pairingCode, reported(false));

  await page.goto("/settings/harnesses/runners");
  await page.getByRole("button", { name: /Subscriber box/ }).click();
  const sheet = page.getByRole("dialog");
  const card = sheet.getByLabel("Codex", { exact: true });
  await expect(card.getByText("Not enrolled.")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("subscription-not-enrolled.png") });

  // Waiting for confirmation: the command holds no secret, the challenge is its own value.
  await card.getByRole("button", { name: "Enroll my subscription" }).click();
  await expect(card.getByText("Waiting for you to confirm it on the runner.")).toBeVisible();
  await expect(card.getByLabel("Command", { exact: true })).toHaveText("dispand-runner enroll codex");
  const challenge = (await card.getByLabel("Challenge", { exact: true }).innerText()).trim();
  expect(challenge).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  await expect(card.getByLabel("Command", { exact: true })).not.toContainText(challenge);
  await page.screenshot({ path: test.info().outputPath("subscription-waiting.png") });

  // The person confirms it on the runner: the app shows it enrolled and forgets the challenge.
  runner.reply({ type: "subscription.enroll", askId: "ask_1", harness: "codex", identity, challenge });
  expect((await runner.waitFor("subscription.enrolled")).enrollmentId).toBeTruthy();
  await expect(card.getByText("Your subscription is enrolled on this runner.")).toBeVisible();
  await expect(page.getByText(challenge)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("subscription-enrolled.png") });

  // The runner reports its login can't renew: a fresh sign-in is needed, with the command and no link or code.
  await sheet.getByRole("button", { name: "Refresh CLIs" }).click();
  const asked = await runner.waitFor("clis.request");
  runner.reply({ type: "clis.replied", requestId: asked.requestId, clis: reported(true) });
  await expect(card.getByText(/A fresh sign-in is needed/)).toBeVisible();
  await expect(card.getByLabel("Command", { exact: true })).toHaveText("dispand-runner sign-in codex");
  await expect(card.getByRole("link")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("subscription-sign-in-needed.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /Subscriber box/ })).toContainText("Sign-in needed");
  await page.screenshot({ path: test.info().outputPath("subscription-runner-list.png") });

  // Their own attended Job on that runner runs on their subscription, and the run says so.
  const harness = await rpc<{ id: string }>(page, "harnesses/create", { name: "Codex on Subscriber box", runnerId: created.runnerId, kind: "codex", permissionMode: "default" });
  const agent = await rpc<{ id: string }>(page, "agents/create", { name: "Personal agent", harnessId: harness.id, systemPrompt: "" });
  const trigger = await rpc<{ id: string }>(page, "triggers/create", { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } });
  const { runId } = await rpc<{ runId: string }>(page, "jobs/start", { triggerId: trigger.id });
  const { start } = await runner.waitFor("session.start");
  expect(start.grant?.enrollmentId).toBeTruthy();
  await page.goto(`/settings/workflows/runs/${runId}`);
  await expect(page.getByText("Personal subscription")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("subscription-run-credential.png") });

  // Revoked: it says so, and offers to enroll again.
  await page.goto("/settings/harnesses/runners");
  await page.getByRole("button", { name: /Subscriber box/ }).click();
  await card.getByRole("button", { name: "Stop using my subscription" }).click();
  await expect(card.getByText("Your enrollment was revoked.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Enroll my subscription" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("subscription-revoked.png") });
});

// A manager's answer reaches a personal action only by escalation (the starter is always asked first, for 72 h),
// which no test reaches through the app: the server's replies are stubbed here, the screen and its one action are real.
test("the subscriber sees another person's answer waiting for them in the Inbox and continues it with one action", async ({ page }) => {
  await signIn(page);
  const at = new Date().toISOString();
  const item = {
    id: "q_consent", runId: "run_x", stepRunId: "s_x", placement: "notifications", payload: { kind: "permission", toolName: "Bash", input: { command: "git push" }, canAlwaysAllow: false },
    status: "answered", answer: { kind: "permission", decision: "allow" }, createdAt: at, answeredAt: at, answeredBy: { type: "user", userId: "manager" }, about: null, proposalId: null, rootId: null,
    consent: "awaiting", yoursToConsent: true, escalation: null, orphaned: false, workflow: null, agent: { id: "a_x", name: "Personal agent", builtIn: null }, trigger: null, kind: "approval", consultRunId: null,
    run: { id: "run_x" }, step: { name: "Personal agent" }, proposal: null, update: null,
  };
  let consented = false;
  await page.route("**/api/rpc/questions/list", (route) => route.fulfill({ json: { json: consented ? [] : [item], meta: consented ? [] : [[1, 0, "createdAt"], [1, 0, "answeredAt"]] } }));
  await page.route("**/api/rpc/questions/consent", (route) => {
    consented = true;
    return route.fulfill({ json: { json: null } });
  });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto("/inbox");
  const waiting = page.getByRole("region", { name: "Waiting for you" });
  const card = waiting.getByRole("article");
  await expect(card.getByText(/Someone else answered this on your personal action/)).toBeVisible();
  await expect(card.getByText("Answered by someone else")).toBeVisible();
  await expect(card.getByRole("button", { name: "Allow" })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("subscription-consent-waiting.png") });
  await card.getByRole("button", { name: "Continue with this answer" }).click();
  await expect(waiting.getByRole("article")).toHaveCount(0);
  expect(consented).toBe(true);
});
