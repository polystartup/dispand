import { expect, test } from "@playwright/test";

// The main project shares the owner created in auth.spec.ts.
test("an invitation registers a new recipient, then returns an existing account to its preview after sign-in", async ({ page, browser, baseURL }) => {
  const credentials = { email: "ada@example.com", password: "correct horse battery" };
  const login = await page.request.post("/api/auth/sign-in/email", { data: credentials, headers: { origin: baseURL! } });
  expect(login.ok()).toBe(true);
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
  const ctx = await browser.newContext({ baseURL });
  try {
    const recipient = await ctx.newPage();
    const requests: string[] = [];
    recipient.on("request", request => requests.push(request.url().split("#")[0]!));
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
    expect(requests.some(url => url.includes(token))).toBe(false);
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
    expect(requests.some(url => url.includes(next))).toBe(false);
  } finally {
    await ctx.close();
  }
});
