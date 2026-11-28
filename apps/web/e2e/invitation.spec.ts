import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// The main project shares the owner its setup created, whom the page is signed in as.
test("an invitation registers a new recipient, then returns an existing account to its preview after sign-in", async ({ page, browser, baseURL }) => {
  const headers = { "x-csrf-token": "orpc" };
  const managed = await page.request.post("/api/rpc/workspace/managed", { headers, data: {} });
  expect(managed.ok()).toBe(true);
  const [scope] = (await managed.json()).json;
  const email = "invitee@example.test";
  const issue = async () => {
    const response = await page.request.post("/api/rpc/workspace/invite", { headers, data: { json: { ...scope, email, role: "member" } } });
    expect(response.ok()).toBe(true);
    return (await response.json()).json.token as string;
  };
  const token = await issue();
  const ctx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const recipient = await ctx.newPage();
    const requests: string[] = [];
    recipient.on("request", (request) => requests.push(request.url().split("#")[0]!));
    await recipient.goto("/invitation#" + token);
    await recipient.getByRole("button", { name: "Create an account" }).click();
    await recipient.getByLabel("Email").fill(email);
    await recipient.getByRole("button", { name: "Review invitation" }).click();
    await expect(recipient.getByText("Ada", { exact: true })).toBeVisible();
    await expect(recipient.getByText("Northwind", { exact: true })).toBeVisible();
    await expect(recipient.getByText("Engineering", { exact: true })).toBeVisible();
    await expect(recipient.getByText(scope.workspaceId, { exact: true })).toHaveCount(0);
    await recipient.getByLabel("Name").fill("Pat");
    await recipient.getByLabel("Password").fill("invited-person-password");
    await recipient.getByRole("button", { name: "Create account and accept" }).click();
    await expect(recipient.getByText("Invitation accepted")).toBeVisible();
    expect(requests.some((url) => url.includes(token))).toBe(false);
    await recipient.reload();
    await expect(recipient.getByRole("alert")).toBeVisible();
    await expect(recipient.getByRole("button", { name: "Accept invitation" })).toHaveCount(0);

    const next = await issue();
    await ctx.clearCookies();
    await recipient.goto("/invitation#" + next);
    await recipient.reload();
    await recipient.getByLabel("Email").fill(email);
    await recipient.getByLabel("Password").fill("invited-person-password");
    await recipient.getByRole("button", { name: "Sign in" }).click();
    await expect(recipient.getByText("Ada", { exact: true })).toBeVisible();
    await recipient.getByRole("button", { name: "Accept invitation" }).click();
    await expect(recipient.getByText("Invitation accepted")).toBeVisible();
    expect(requests.some((url) => url.includes(next))).toBe(false);

    // Taken off the workspace, the signed-in person finds whom to ask instead of an error.
    const asOwner = { ...headers, "dispand-organization": scope.organizationId };
    const directory = await page.request.post("/api/rpc/organization/directory", { headers: asOwner, data: {} });
    const pat = (await directory.json()).json.people.find((p: { email: string }) => p.email === email);
    const taken = await page.request.post("/api/rpc/organization/unassign", {
      headers: asOwner,
      data: { json: { userId: pat.userId, workspaceId: scope.workspaceId } },
    });
    expect(taken.ok()).toBe(true);
    await recipient.goto("/");
    await expect(recipient.getByRole("heading", { name: "No workspace yet" })).toBeVisible();
    await expect(recipient.getByText("Ask the owner of Northwind to add you to one:")).toBeVisible();
    await expect(recipient.getByRole("link", { name: "ada@example.com" })).toBeVisible();
    await recipient.screenshot({ path: test.info().outputPath("no-workspace-light.png"), animations: "disabled" });
    expect((await new AxeBuilder({ page: recipient }).withTags(WCAG).analyze()).violations).toEqual([]);
    await recipient.emulateMedia({ colorScheme: "dark" });
    await recipient.screenshot({ path: test.info().outputPath("no-workspace-dark.png"), animations: "disabled" });
    expect((await new AxeBuilder({ page: recipient }).withTags(WCAG).analyze()).violations).toEqual([]);
  } finally {
    await ctx.close();
  }
});
