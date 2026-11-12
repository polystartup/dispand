import { expect, test } from "@playwright/test";

test("fresh app asks for setup, shows the shell, and signs out to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.waitForLoadState("networkidle"); // the form submits through JS once hydrated

  await page.getByLabel("Name").fill("Ada");
  await page.getByLabel("Setup code").fill("dev-setup-code-0123456789");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();

  // The first page is the Assistant's, which asks where it runs: there is no harness yet.
  await expect(page).toHaveURL(/\/assistant$/);
  const sidebar = page.getByRole("navigation", { name: "Main" });
  await expect(sidebar.getByRole("link", { name: "Home" })).toBeVisible();
  for (const name of ["Assistant", "Harnesses", "Agents", "Skills", "Tools", "Data", "Workflows", "Help"]) {
    await expect(sidebar.getByRole("link", { name })).toBeVisible();
  }
  await expect(page.getByText("Choose where the Assistant runs")).toBeVisible();

  await page.getByRole("link", { name: "Skills" }).click();
  await expect(page).toHaveURL(/\/settings\/skills$/);
  await expect(page.getByText("No skill yet")).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto("/settings/agents");
  await expect(page).toHaveURL(/\/login$/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/assistant$/);
});

test("the shell turns into a sheet at 360px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(page.getByRole("link", { name: "Agents" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open menu" }).click();
  const sheet = page.getByRole("dialog", { name: "Menu" });
  await expect(sheet.getByRole("link", { name: "Agents" })).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
  await expect(page.getByRole("link", { name: "Agents" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open menu" }).click();
  await sheet.getByRole("link", { name: "Agents" }).click();
  await expect(page).toHaveURL(/\/settings\/agents$/);
  await expect(sheet).toHaveCount(0);
});

test("the user menu works with the keyboard", async ({ page }) => {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/assistant$/);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Account menu" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Account menu" })).toBeFocused();
});

test("a network failure on sign-in shows an error and re-enables the button", async ({ page }) => {
  await page.route("**/api/auth/sign-in/email", (route) => route.abort());
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  const button = page.getByRole("button", { name: "Sign in" });
  await button.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(button).toBeEnabled();
});

test("growing the window closes the mobile sheet", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/assistant$/);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page).toHaveURL(/\/settings\/agents$/);
});

test("a failed sign-out keeps the user in the app with an error, and works on retry", async ({ page }) => {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/assistant$/);
  await page.waitForLoadState("networkidle");

  let fail = true;
  await page.route("**/api/auth/sign-out", (route) => {
    if (!fail) return route.continue();
    fail = false;
    return route.fulfill({ status: 500, body: "{}" });
  });
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/assistant$/);

  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
