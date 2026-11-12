import { expect, test } from "@playwright/test";

test("an incompatible runner can update from Settings using its separate authenticated channel", async ({ page, request }) => {
  await page.goto("/");
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
  await expect(page).toHaveURL(/\/(assistant)?$/);
  await page.goto("/settings/harnesses/runners");
  await page.getByRole("button", { name: "Add runner" }).click();
  await page.getByLabel("Runner name").fill("Update test machine");
  await page.getByRole("button", { name: "Get the install command" }).click();
  const command = await page.getByLabel("Install command").innerText();
  const code = /DISPAND_PAIRING_CODE=([A-Z0-9]{8})/.exec(command)![1];
  const paired = await request.post("/runner/pair", { data: { code } });
  const { token } = await paired.json();
  const headers = { authorization: `Bearer ${token}`, "dispand-runner-build": "0".repeat(64) };
  expect((await request.post("/runner/update", { headers: { ...headers, authorization: "Bearer invalid" } })).status()).toBe(401);
  expect((await request.post("/runner/update", { headers: { ...headers, "dispand-runner-build": "bad" } })).status()).toBe(400);
  expect(await (await request.post("/runner/update", { headers })).json()).toEqual({ update: false });
  // No session WebSocket was opened: only the update channel is reachable.
  await page.goto("/settings/harnesses/runners");
  await expect(page.getByRole("button", { name: /Update test machine/ })).toContainText("Update available");
  await page.getByRole("button", { name: /Update test machine/ }).click();
  await page.getByRole("button", { name: "Update runner", exact: true }).click();
  await expect(page.getByRole("button", { name: "Updating…", exact: true })).toBeDisabled();
  await page.screenshot({ path: "/tmp/dispand-runner-update.png" });
  expect(await (await request.post("/runner/update", { headers })).json()).toEqual({ update: true });
  expect(await (await request.post("/runner/update", { headers })).json()).toEqual({ update: false });
  const { buildId } = await (await request.get("/runner/build.json")).json();
  await request.post("/runner/update", { headers: { ...headers, "dispand-runner-build": buildId } });
  await expect(page.getByText("Runner is up to date.")).toBeVisible({ timeout: 15_000 });
});
