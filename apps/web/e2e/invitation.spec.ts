import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { hydrated } from "./hydrated.ts";

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

    // The owner hands the organization over: with no workspace role of their own, they see whom to ask.
    const ada = (await (await page.request.post("/api/rpc/organization/directory", { headers: asOwner, data: {} })).json()).json.people.find(
      (p: { role: string }) => p.role === "owner",
    );
    const shot = async (name: string) => {
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await page.screenshot({ path: test.info().outputPath(`${name}-${colorScheme}.png`), animations: "disabled" });
      }
      await page.emulateMedia({ colorScheme: "light" });
    };
    await page.goto("/settings/people");
    await hydrated(page);
    const make = page.getByRole("button", { name: "Make Pat the organization’s owner" });
    await make.scrollIntoViewIfNeeded();
    await shot("organization-members");
    await make.click();
    const handOver = page.getByRole("dialog", { name: "Make Pat the owner?" });
    await expect(handOver).toContainText("until Pat gives you one");
    await shot("make-owner");
    try {
      await handOver.getByRole("button", { name: "Make owner" }).click();
      await expect(page.getByRole("heading", { name: "No workspace yet" })).toBeVisible();
      await expect(page.getByRole("link", { name: email })).toBeVisible();
    } finally {
      // Handed back: the rest of the project is the first owner's.
      await recipient.request.post("/api/rpc/organization/transferOwnership", { headers: asOwner, data: { json: { userId: ada.userId } } });
    }

    // The owner removes them from the organization; their account stays.
    await page.reload();
    await hydrated(page);
    await page.getByRole("button", { name: "Remove Pat from the organization" }).click();
    await shot("remove-from-organization");
    await page.getByRole("dialog", { name: "Remove Pat from the organization?" }).getByRole("button", { name: "Remove from organization" }).click();
    await expect(page.getByText("Pat removed from the organization.")).toBeVisible();
    await recipient.reload();
    await expect(recipient.getByText("You don't belong to any organization.", { exact: false })).toBeVisible();
  } finally {
    await ctx.close();
  }
});
