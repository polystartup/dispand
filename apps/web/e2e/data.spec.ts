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

async function addField(page: Page, name: string, type: string) {
  await page.getByRole("button", { name: "Add a field" }).click();
  await page.getByLabel("Field name").fill(name);
  await page.getByLabel("Type").selectOption({ label: type });
  await page.getByRole("button", { name: "Add field" }).click();
  await expect(page.getByRole("columnheader", { name: new RegExp(name) })).toBeVisible();
}

const cell = (page: Page, field: string, row = 0) => page.getByRole("gridcell", { name: field, exact: true }).nth(row);
const headers = (page: Page) => page.getByRole("columnheader").allInnerTexts();

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

test("a table: fields, inline edits, rename, move, retype and delete", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/data");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New table" }).click();
  await page.getByRole("textbox", { name: "Table name" }).fill("Projects");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/settings\/data\/tbl_/);
  await expect(page.getByRole("textbox", { name: "Table name" })).toHaveValue("Projects");

  // Spec 9.1 step 4: the fields of the Projects table.
  await addField(page, "Short description", "Long text");
  await addField(page, "Mission statement", "Long text");
  await addField(page, "Logo", "Files");
  await addField(page, "Repository URL", "URL");
  await addField(page, "Website URL", "URL");

  // A row: type a name, Tab to the next cell and type there.
  await page.getByRole("button", { name: "New row" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Dispand");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Agents and workflows");
  await page.keyboard.press("Control+Enter");
  await expect(cell(page, "Short description")).toHaveText("Agents and workflows");
  await cell(page, "Website URL").dblclick();
  await page.getByRole("textbox", { name: "Website URL" }).fill("not a url");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("expected an http(s) URL");
  await page.getByRole("textbox", { name: "Website URL" }).fill("https://dispand.example");
  await page.keyboard.press("Enter");
  await expect(cell(page, "Website URL")).toHaveText("https://dispand.example");

  await page.reload();
  await expect(cell(page, "Name")).toHaveText("Dispand");
  await expect(cell(page, "Short description")).toHaveText("Agents and workflows");
  await shots(page, "task-5-grid");

  // Rename a field, then move it left.
  await page.getByRole("button", { name: "Field menu: Website URL" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByLabel("Field name").fill("Site");
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("columnheader", { name: /Site/ })).toBeVisible();
  await page.getByRole("button", { name: "Field menu: Site" }).click();
  await page.getByRole("menuitem", { name: "Move left" }).click();
  await expect.poll(async () => (await headers(page)).map((h) => h.trim()).filter(Boolean).slice(-2)).toEqual(["Site", "Repository URL"]);

  // Retype a text field holding "12" and "about 20" to number.
  await addField(page, "Budget", "Text");
  await cell(page, "Budget").click();
  await page.keyboard.type("12");
  await page.keyboard.press("Enter");
  await expect(cell(page, "Budget")).toHaveText("12");
  await page.getByRole("button", { name: "New row" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Someday");
  await page.keyboard.press("Enter");
  await cell(page, "Budget", 1).click();
  await page.keyboard.type("about 20");
  await page.keyboard.press("Enter");
  await expect(cell(page, "Budget", 1)).toHaveText("about 20");
  await page.getByRole("button", { name: "Field menu: Budget" }).click();
  await page.getByRole("menuitem", { name: "Change type" }).click();
  await page.getByLabel("New type").selectOption({ label: "Number" });
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText("1 value will be converted, 1 can't be and will be cleared.");
  await shots(page, "task-5-retype");
  await page.getByRole("button", { name: "Change type" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(cell(page, "Budget")).toHaveText("12");
  await expect(cell(page, "Budget", 1)).toHaveText("");

  // Delete the field, then a row.
  await page.getByRole("button", { name: "Field menu: Budget" }).click();
  await page.getByRole("menuitem", { name: "Delete field" }).click();
  await page.getByRole("button", { name: "Delete field" }).click();
  await expect(page.getByRole("columnheader", { name: /Budget/ })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Select row" }).nth(1).check();
  await page.getByRole("button", { name: "Delete 1 row" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("gridcell", { name: "Name", exact: true })).toHaveCount(1);
  await expect(page.getByText("1 row", { exact: true })).toBeVisible();

  // The list shows the table and its rows.
  await page.getByRole("link", { name: "Data" }).first().click();
  await expect(page.getByRole("link", { name: /Projects/ })).toContainText("1 row");
  await shots(page, "task-5-tables");
});

// A 1×1 PNG, and an SVG that would run a script if it were shown inline.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

test("sort, filter, row detail and files", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/data");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New table" }).click();
  await page.getByRole("textbox", { name: "Table name" }).fill("Launches");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/settings\/data\/tbl_/);
  await addField(page, "Score", "Number");
  await addField(page, "Mission statement", "Long text");
  await addField(page, "Logo", "Files");
  for (const [name, score] of [["Dispand", "5"], ["Other", "9"]]) {
    await page.getByRole("button", { name: "New row" }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill(name!);
    await page.keyboard.press("Tab");
    await page.keyboard.type(score!);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("gridcell", { name: "Name", exact: true }).filter({ hasText: name! })).toBeVisible();
  }

  // Filter: Name contains "Disp" shows 1 of 2 rows, and a reload keeps it. A row selected and
  // then hidden by the filter can't be deleted.
  await page.getByRole("checkbox", { name: "Select row" }).nth(1).check();
  await expect(page.getByRole("button", { name: "Delete 1 row" })).toBeVisible();
  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByLabel("Filter value").fill("Disp");
  await expect(page.getByRole("status").filter({ hasText: "of" })).toHaveText("1 of 2 rows");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^Delete \d+ rows?$/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "of" })).toHaveText("1 of 2 rows");
  await expect(cell(page, "Name")).toHaveText("Dispand");
  await page.getByRole("button", { name: "Filter (1)" }).click();
  await page.getByRole("button", { name: "Remove filter" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByText("2 rows", { exact: true })).toBeVisible();

  // Sort by Score, descending.
  await page.getByRole("button", { name: "Sort" }).click();
  await page.getByRole("button", { name: "Add sort" }).click();
  await page.getByLabel("Sort field").selectOption({ label: "Score" });
  await page.getByLabel("Sort direction").selectOption({ label: "Descending" });
  await page.keyboard.press("Escape");
  await expect(cell(page, "Name", 0)).toHaveText("Other");
  await expect(cell(page, "Name", 1)).toHaveText("Dispand");

  // The row detail: edit the mission statement, close, the grid shows it.
  await page.getByRole("button", { name: "Open row" }).nth(1).click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByRole("heading", { name: "Dispand" })).toBeVisible();
  await detail.getByRole("textbox", { name: "Mission statement" }).fill("Let agents do the busywork.");
  await detail.getByRole("textbox", { name: "Mission statement" }).blur();

  // Files: a PNG shows as a thumbnail, an SVG only as a file chip.
  await detail.getByLabel("Upload to Logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await expect(detail.getByRole("img", { name: "logo.png" })).toBeVisible();
  await detail.getByLabel("Upload to Logo").setInputFiles({ name: "evil.svg", mimeType: "image/svg+xml", buffer: SVG });
  await expect(detail.getByRole("link", { name: "evil.svg" })).toBeVisible();
  await expect(detail.getByRole("img", { name: "evil.svg" })).toHaveCount(0);
  await shots(page, "task-6-row-detail");
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(cell(page, "Mission statement", 1)).toHaveText("Let agents do the busywork.");
  const logo = cell(page, "Logo", 1);
  await expect(logo.getByRole("img", { name: "logo.png" })).toBeVisible();
  await expect(logo.getByRole("link", { name: "evil.svg" })).toBeVisible();
  await expect(logo.getByRole("img", { name: "evil.svg" })).toHaveCount(0);
  // The thumbnail is really served as an image.
  const src = await logo.getByRole("img", { name: "logo.png" }).getAttribute("src");
  const res = await page.request.get(src!);
  expect(res.headers()["content-type"]).toBe("image/png");
  await shots(page, "task-6-grid");
});
