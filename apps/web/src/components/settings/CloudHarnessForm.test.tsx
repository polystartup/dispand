// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../lib/api.ts", async () => (await import("../../test/fake-api.ts")).apiModule());
const { fake } = await import("../../test/fake-api.ts");
const { cloudHarness } = await import("../../test/fixtures.ts");
const { CloudHarnessForm } = await import("./CloudHarnessForm.tsx");
const { createI18n } = await import("../../lib/i18n.ts");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function form(harness?: Parameters<typeof CloudHarnessForm>[0]["harness"], language: "en" | "fr" = "en") {
  const onSaved = vi.fn();
  render(
    <I18nextProvider i18n={createI18n(language)}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CloudHarnessForm harness={harness} onClose={() => {}} onSaved={onSaved} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { onSaved, user: userEvent.setup() };
}

test("a refused field says why on the field, and nothing is sent", async () => {
  const { user } = form();
  await user.click(screen.getByRole("button", { name: "Create harness" }));
  const name = screen.getByLabelText("Name");
  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(name.getAttribute("aria-describedby")).toBeTruthy();
  expect(screen.getByLabelText("API key").getAttribute("aria-invalid")).toBe("true");
  expect(screen.getAllByRole("alert").map((a) => a.textContent)).toContain("An API key is required.");
  expect(fake.harnesses.create).not.toHaveBeenCalled();
  // The error goes as the field is put right.
  await user.type(name, "Claude API");
  await waitFor(() => expect(name.getAttribute("aria-invalid")).toBeNull());
});

test("the reasons are in the page's language", async () => {
  const { user } = form(undefined, "fr");
  await user.click(screen.getByRole("button", { name: "Créer le harnais" }));
  expect(screen.getAllByRole("alert").map((a) => a.textContent)).toContain("Saisissez un nom de 100 caractères au plus.");
});

test("a saved key is kept only for the address it was saved for", async () => {
  const { user } = form(cloudHarness({ baseUrl: "https://proxy.example.com", apiKeySet: true }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.queryAllByRole("alert")).toEqual([]);
  expect(fake.harnesses.update).toHaveBeenCalledTimes(1);
  vi.resetAllMocks();
  await user.clear(screen.getByLabelText("Base URL (optional)"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByLabelText("API key").getAttribute("aria-invalid")).toBe("true");
  expect(fake.harnesses.update).not.toHaveBeenCalled();
});

test("a submit sent twice before the first answers creates one harness", async () => {
  const saved = cloudHarness({ id: "harness_2", name: "Claude API" });
  let answer: (harness: typeof saved) => void = () => {};
  fake.harnesses.create.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
  const { user, onSaved } = form();
  await user.type(screen.getByLabelText("Name"), "Claude API");
  await user.type(screen.getByLabelText("API key"), "sk-secret");
  const save = screen.getByRole("button", { name: "Create harness" });
  await user.click(save);
  await user.type(screen.getByLabelText("Name"), "{Enter}");
  await user.click(save);
  expect(fake.harnesses.create).toHaveBeenCalledTimes(1);
  expect(fake.harnesses.create).toHaveBeenCalledWith(
    expect.objectContaining({ type: "cloud", kind: "anthropic", name: "Claude API", apiKey: "sk-secret", model: "claude-opus-5-5" }),
    expect.anything(),
  );
  answer(saved);
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved, true));
});

test("a malformed address with a key entered is an error on its field, not a crash", async () => {
  const { user } = form();
  await user.click(screen.getByRole("button", { name: "Create harness" }));
  await user.type(screen.getByLabelText("Name"), "Claude API");
  await user.type(screen.getByLabelText("API key"), "sk-secret");
  await user.type(screen.getByLabelText("Base URL (optional)"), "not a url");
  await waitFor(() => expect(screen.getByLabelText("Base URL (optional)").getAttribute("aria-invalid")).toBe("true"));
  expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBeNull();
});
