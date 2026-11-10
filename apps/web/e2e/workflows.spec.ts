import { expect, test, type Page } from "@playwright/test";

/** Signs in as the owner created by the earlier specs (settings.spec.ts also created the agent "Writer"). */
async function signIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("a chat workflow with one agent step: expected outputs follow the prompt, edits autosave", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/workflows");
  await expect(page.getByText("No workflow yet")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New workflow" }).click();
  await expect(page).toHaveURL(/\/settings\/workflows\/wf_/);

  await page.getByLabel("Workflow name").fill("Ship an idea");
  const panel = page.getByRole("complementary", { name: "Step settings" });
  await panel.getByRole("radio", { name: "Chat" }).click();
  await panel.getByLabel("Name").fill("Brief");
  await panel.getByLabel("Agent").click();
  await page.getByRole("option", { name: "Writer" }).click();
  await panel.getByLabel("Prompt").fill("Ask what we should build and for whom.");
  await expect(panel.getByText("None yet.")).toBeVisible();

  await page.getByRole("button", { name: "Add a step after Brief" }).click();
  await page.getByRole("menuitem", { name: "Agent" }).click();
  await expect(panel.getByText("Agent step")).toBeVisible();
  await panel.getByLabel("Name").fill("Plan");
  await panel.getByLabel("Agent").click();
  await page.getByRole("option", { name: "Writer" }).click();
  const prompt = panel.getByLabel("Prompt");
  await prompt.pressSequentially("Plan {{");
  await expect(page.getByRole("option", { name: "brief.…" })).toBeVisible();
  await prompt.press("Enter");
  await prompt.pressSequentially("idea}} for {{brief.audience}}.");
  await expect(prompt).toHaveValue("Plan {{brief.idea}} for {{brief.audience}}.");

  // The chat's expected outputs come from the step's prompt.
  await page.getByRole("button", { name: "Add a step after Plan" }).waitFor();
  await page.locator(".react-flow__node").filter({ hasText: "Brief" }).click();
  const outputs = panel.getByRole("list", { name: "Expected outputs" });
  await expect(outputs).toContainText("idea");
  await expect(outputs).toContainText("audience");
  await expect(page.getByRole("status")).toHaveText(/^Saved$/, { timeout: 5_000 });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: test.info().outputPath("workflow-editor-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  // Let the colour transitions finish.
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath("workflow-editor-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });

  // A reference to a later step is reported where it is.
  await page.locator(".react-flow__node").filter({ hasText: "Plan" }).click();
  await prompt.fill("Plan {{brief.idea}} with {{plan.x}}.");
  await expect(panel.getByRole("list", { name: "Issues" })).toContainText("“plan” doesn't run before this step");
  await prompt.fill("Plan {{brief.idea}} for {{brief.audience}}.");
  await expect(page.getByRole("status")).toHaveText(/^Saved$/, { timeout: 5_000 });

  // Saved: a reload shows the same workflow.
  await page.reload();
  await expect(page.getByLabel("Workflow name")).toHaveValue("Ship an idea");
  await expect(page.locator(".react-flow__node").filter({ hasText: "Plan" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Step settings" }).getByRole("list", { name: "Expected outputs" })).toContainText("audience");
  await page.goto("/settings/workflows");
  await expect(page.getByRole("link", { name: /Ship an idea/ })).toBeVisible();

  // Leaving right after an edit, then coming back, shows the edit (saved on the way out).
  await page.getByRole("link", { name: /Ship an idea/ }).click();
  await page.locator(".react-flow__node").filter({ hasText: "Plan" }).click();
  await page.getByRole("complementary", { name: "Step settings" }).getByLabel("Prompt").fill("Plan {{brief.idea}} quickly.");
  await page.getByRole("link", { name: "Workflows" }).first().click();
  await page.getByRole("link", { name: /Ship an idea/ }).click();
  await page.locator(".react-flow__node").filter({ hasText: "Plan" }).click();
  await expect(page.getByRole("complementary", { name: "Step settings" }).getByLabel("Prompt")).toHaveValue("Plan {{brief.idea}} quickly.");
  await page.reload();
  await page.locator(".react-flow__node").filter({ hasText: "Plan" }).click();
  await expect(page.getByRole("complementary", { name: "Step settings" }).getByLabel("Prompt")).toHaveValue("Plan {{brief.idea}} quickly.");
});

test("a step added from the trigger's \"+\" twice makes two branches, and linking them to a third makes a join", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await page.goto("/settings/workflows");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New workflow" }).click();
  await expect(page).toHaveURL(/\/settings\/workflows\/wf_/);
  await page.getByLabel("Workflow name").fill("Branches");
  const add = async (label: string) => {
    await page.getByRole("button", { name: label }).click();
    await page.getByRole("menuitem", { name: "Agent" }).click();
  };
  await add("Add a step after Start");
  await add("Add a step after Start");
  await add("Add a step after Step 1");
  const card = (name: string) => page.locator(".react-flow__node").filter({ hasText: name });
  await expect(card("Step 3")).toBeVisible();
  const edges = page.locator(".react-flow__edge");
  await expect(edges).toHaveCount(3);

  // Step 2's bottom handle dragged to Step 3's top one: Step 3 joins both branches.
  const drag = async (from: string, to: string) => {
    const source = (await card(from).locator(".react-flow__handle.source").boundingBox())!;
    const target = (await card(to).locator(".react-flow__handle.target").boundingBox())!;
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
    await page.mouse.up();
  };
  await drag("Step 2", "Step 3");
  await expect(edges).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Add a step between Step 2 and Step 3" })).toBeVisible();

  // A link that would make a loop is refused, with why.
  await drag("Step 3", "Step 1");
  await expect(page.getByRole("alert")).toHaveText("This link would make a loop");
  await expect(edges).toHaveCount(4);

  await expect(page.getByRole("status")).toHaveText(/^Saved/, { timeout: 5_000 });
  await page.screenshot({ path: test.info().outputPath("workflow-join.png") });
  await page.reload();
  await expect(edges).toHaveCount(4);
  const res = await page.request.post("/api/rpc/workflows/get", {
    headers: { "x-csrf-token": "orpc" },
    data: { json: { id: page.url().split("/").at(-1) } },
  });
  const { def } = ((await res.json()) as { json: { def: { edges: unknown[] } } }).json;
  expect(def.edges).toHaveLength(4);
});

test("a condition with Then and Else branches autosaves both branch labels", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await page.goto("/settings/workflows");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New workflow" }).click();
  await expect(page).toHaveURL(/\/settings\/workflows\/wf_/);
  await page.getByLabel("Workflow name").fill("Approve");
  const panel = page.getByRole("complementary", { name: "Step settings" });
  await panel.getByRole("radio", { name: "Chat" }).click();
  await panel.getByLabel("Name").fill("Brief");
  await panel.getByLabel("Agent").click();
  await page.getByRole("option", { name: "Writer" }).click();
  await panel.getByLabel("Prompt").fill("Ask whether we go ahead.");

  // The condition compares a value it asks the chat for.
  await page.getByRole("button", { name: "Add a step after Brief" }).click();
  await page.getByRole("menuitem", { name: "Condition" }).click();
  await expect(panel.getByText("Condition", { exact: true })).toBeVisible();
  await panel.getByLabel("From").selectOption({ label: "Brief" });
  await panel.getByLabel("Value").fill("approved");
  await expect(panel.getByLabel("Operator")).toHaveValue("equals");
  await panel.getByLabel("Compare with").fill("yes");
  const card = (name: string) => page.locator(".react-flow__node").filter({ hasText: name });
  await expect(card("If")).toContainText("brief.approved is yes");

  const add = async (label: string, type = "Agent") => {
    await page.getByRole("button", { name: label }).click();
    await page.getByRole("menuitem", { name: type }).click();
  };
  await add("Add a step on If's Then branch");
  await panel.getByLabel("Name").fill("Ship");
  await add("Add a step on If's Else branch");
  await panel.getByLabel("Name").fill("Rethink");
  const edges = page.locator(".react-flow__edge");
  await expect(edges).toHaveCount(3);
  await expect(page.locator(".react-flow__edgelabel-renderer")).toContainText("Then");
  await expect(page.locator(".react-flow__edgelabel-renderer")).toContainText("Else");

  // A condition inserted on a link leads on through Then: still saveable.
  await add("Add a step between If and Ship", "Condition");
  await expect(edges).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Add a step between If 2 and Ship" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(/^Saved/, { timeout: 5_000 });

  await page.locator(".react-flow__pane").click();
  await page.screenshot({ path: test.info().outputPath("workflow-condition-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath("workflow-condition-dark.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await card("If 2").click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath("workflow-condition-phone-dark.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath("workflow-condition-phone-light.png"), fullPage: true });

  const res = await page.request.post("/api/rpc/workflows/get", {
    headers: { "x-csrf-token": "orpc" },
    data: { json: { id: page.url().split("/").at(-1) } },
  });
  type Saved = { steps: { id: string; name: string; type: string; op?: string; operand?: string }[]; edges: { from: string; to: string; branch?: string }[] };
  const { def } = ((await res.json()) as { json: { def: Saved } }).json;
  const id = (name: string) => def.steps.find((s) => s.name === name)!.id;
  expect(def.steps.find((s) => s.name === "If")).toMatchObject({ type: "condition", op: "equals", operand: "yes" });
  expect(def.edges).toEqual(
    expect.arrayContaining([
      { from: id("If"), to: id("If 2"), branch: "then" },
      { from: id("If 2"), to: id("Ship"), branch: "then" },
      { from: id("If"), to: id("Rethink"), branch: "else" },
    ]),
  );
});

test("switching the trigger to Schedule saves it and shows the next run", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await page.goto("/settings/workflows");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New workflow" }).click();
  await expect(page).toHaveURL(/\/settings\/workflows\/wf_/);
  await page.getByLabel("Workflow name").fill("Morning report");
  const panel = page.getByRole("complementary", { name: "Step settings" });
  await panel.getByRole("radio", { name: "Schedule" }).click();
  await expect(panel.getByRole("radio", { name: "Weekdays" })).toHaveAttribute("aria-checked", "true");
  await panel.getByRole("radio", { name: "Every week" }).click();
  await panel.getByLabel("Day", { exact: true }).selectOption({ label: "Monday" });
  await panel.getByLabel("Time", { exact: true }).fill("08:30");
  const card = page.locator(".react-flow__node").filter({ hasText: "Every Monday at 08:30" });
  await expect(card).toBeVisible();
  await expect(panel.getByRole("list", { name: "Next runs" }).getByRole("listitem")).toHaveCount(3);
  await expect(panel.getByRole("list", { name: "Next runs" }).getByRole("listitem").first()).toContainText(/^Mon \d+ \w+, 08:30$/);
  await page.getByRole("button", { name: "Add a step after Start" }).click();
  await page.getByRole("menuitem", { name: "Agent" }).click();
  await panel.getByLabel("Name").fill("Report");
  await panel.getByLabel("Agent").click();
  await page.getByRole("option", { name: "Writer" }).click();
  await panel.getByLabel("Prompt").fill("Report for {{start.scheduled_for}}.");
  await expect(page.getByRole("status")).toHaveText(/^Saved$/, { timeout: 5_000 });

  // Saved: the schedule exists, and the Paused switch drives it.
  await card.click();
  const paused = panel.getByRole("switch", { name: "Paused" });
  await expect(paused).toBeEnabled();
  await expect(paused).not.toBeChecked();
  await page.screenshot({ path: test.info().outputPath("schedule-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath("schedule-dark.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath("schedule-phone-dark.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath("schedule-phone-light.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });

  await paused.click();
  await expect(paused).toBeChecked();
  const res = await page.request.post("/api/rpc/workflows/get", {
    headers: { "x-csrf-token": "orpc" },
    data: { json: { id: page.url().split("/").at(-1) } },
  });
  const saved = ((await res.json()) as { json: { def: { trigger: { type: string; field: { cron: string; timezone: string } } }; schedule: { enabled: boolean } } }).json;
  expect(saved.def.trigger).toMatchObject({ type: "schedule", field: { cron: "30 8 * * 1", timezone: "Europe/Paris" } });
  expect(saved.schedule.enabled).toBe(false);
});

test("a For each added after the trigger takes a step inside its body", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await page.goto("/settings/workflows");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New workflow" }).click();
  await expect(page).toHaveURL(/\/settings\/workflows\/wf_/);
  await page.getByLabel("Workflow name").fill("Digest");
  const panel = page.getByRole("complementary", { name: "Step settings" });
  await panel.getByRole("radio", { name: "Chat" }).click();
  await panel.getByLabel("Name").fill("Brief");
  await panel.getByLabel("Agent").click();
  await page.getByRole("option", { name: "Writer" }).click();
  await panel.getByLabel("Prompt").fill("Ask for the list of topics.");

  await page.getByRole("button", { name: "Add a step after Brief" }).click();
  await page.getByRole("menuitem", { name: "For each" }).click();
  await expect(panel.getByText("Loop", { exact: true })).toBeVisible();
  await panel.getByLabel("From").selectOption({ label: "Brief" });
  await panel.getByLabel("Value").fill("items");
  const group = page.locator(".react-flow__node-loop");
  await expect(group).toContainText("For each brief.items");
  await expect(group).toContainText("at most 20");
  await panel.getByLabel("At most").fill("5");
  await expect(group).toContainText("at most 5");

  // The empty body has its own "+": loops can't be nested, so it doesn't offer "For each".
  await page.getByRole("button", { name: "Add a step inside For each" }).click();
  await expect(page.getByRole("menuitem", { name: "Agent" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "For each" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Agent" }).click();
  await panel.getByLabel("Name").fill("Summarize");
  await panel.getByLabel("Agent").click();
  await page.getByRole("option", { name: "Writer" }).click();
  await panel.getByLabel("Prompt").fill("Summarize {{for_each.item}} (number {{for_each.index}}).");
  await expect(panel.getByRole("list", { name: "Issues" })).toHaveCount(0);

  const card = (name: string) => page.locator(".react-flow__node-card").filter({ hasText: name });
  await expect(card("Summarize")).toBeVisible();
  const inside = async () => {
    const outer = (await group.boundingBox())!;
    const body = (await card("Summarize").boundingBox())!;
    return body.x >= outer.x && body.y >= outer.y && body.x + body.width <= outer.x + outer.width && body.y + body.height <= outer.y + outer.height;
  };
  expect(await inside()).toBe(true);
  // The body's "+" doesn't offer "For each" either.
  await page.getByRole("button", { name: "Add a step after Summarize" }).click();
  await expect(page.getByRole("menuitem", { name: "Condition" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "For each" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // What comes after the loop hangs under its box, outside its body.
  await page.getByRole("button", { name: "Add a step after For each", exact: true }).click();
  await page.getByRole("menuitem", { name: "Agent" }).click();
  await panel.getByLabel("Name").fill("Wrap up");
  await panel.getByLabel("Agent").click();
  await page.getByRole("option", { name: "Writer" }).click();
  await panel.getByLabel("Prompt").fill("Done after {{for_each.count}} topics.");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.getByRole("status")).toHaveText(/^Saved/, { timeout: 5_000 });

  await group.getByText("For each brief.items").click();
  await page.screenshot({ path: test.info().outputPath("workflow-loop-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath("workflow-loop-dark.png") });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath("workflow-loop-phone-dark.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath("workflow-loop-phone-light.png"), fullPage: true });

  const res = await page.request.post("/api/rpc/workflows/get", {
    headers: { "x-csrf-token": "orpc" },
    data: { json: { id: page.url().split("/").at(-1) } },
  });
  type Saved = { steps: { id: string; name: string; type: string; loopId?: string; maxIterations?: number; list?: unknown }[]; edges: { from: string; to: string }[] };
  const { def } = ((await res.json()) as { json: { def: Saved } }).json;
  const step = (name: string) => def.steps.find((s) => s.name === name)!;
  const loop = step("For each");
  expect(loop).toMatchObject({ type: "loop", maxIterations: 5, list: { type: "output", name: "items" } });
  expect(step("Summarize").loopId).toBe(loop.id);
  expect(step("Wrap up").loopId).toBeUndefined();
  // The body's step has no link in or out: it starts and ends the iteration.
  expect(def.edges).toHaveLength(2);
  expect(def.edges).toContainEqual({ from: loop.id, to: step("Wrap up").id });
});
