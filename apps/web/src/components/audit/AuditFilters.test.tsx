// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ agents: { list: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { AuditFilters, auditFilter } = await import("./AuditFilters.tsx");
const { createI18n, resources } = await import("../../lib/i18n.ts");
const { AUDIT_FAMILIES } = await import("@dispand/domain/audit/model");

afterEach(cleanup);

function mount(value: Record<string, string>, onChange = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={createI18n("en")}>
        <AuditFilters value={value} onChange={onChange} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return onChange;
}

test("each filter hands its value to the page, which keeps it in the URL", async () => {
  const user = userEvent.setup();
  fake.agents.list.mockResolvedValue([{ id: "agent_1", name: "Clerk" }]);
  const onChange = mount({ result: "failed" });
  await screen.findByRole("option", { name: "Clerk" });
  await user.selectOptions(screen.getByLabelText("Who"), "user");
  expect(onChange).toHaveBeenLastCalledWith({ result: "failed", actorType: "user" });
  await user.selectOptions(screen.getByLabelText("Agent"), "agent_1");
  expect(onChange).toHaveBeenLastCalledWith({ result: "failed", agentId: "agent_1" });
  await user.selectOptions(screen.getByLabelText("What"), "question");
  expect(onChange).toHaveBeenLastCalledWith({ result: "failed", action: "question" });
  await user.selectOptions(screen.getByLabelText("On what"), "table");
  expect(onChange).toHaveBeenLastCalledWith({ result: "failed", resourceType: "table" });
  await user.selectOptions(screen.getByLabelText("How it ended"), "");
  expect(onChange).toHaveBeenLastCalledWith({ result: undefined });
  await user.type(screen.getByLabelText("From"), "2026-11-12");
  expect(onChange).toHaveBeenLastCalledWith({ result: "failed", from: "2026-11-12" });
});

test("what the URL holds shows in the filters, and a Job filter can be cleared", async () => {
  const user = userEvent.setup();
  fake.agents.list.mockResolvedValue([]);
  const onChange = mount({ result: "failed", jobId: "run_1", to: "2026-11-13" });
  expect((screen.getByLabelText("How it ended") as HTMLSelectElement).value).toBe("failed");
  expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("2026-11-13");
  expect(screen.getByText("Only the Job run_1")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Show every Job" }));
  expect(onChange).toHaveBeenCalledWith({ result: "failed", jobId: undefined, to: "2026-11-13" });
});

test("the URL's filters become the list's: the days cover whole local days", () => {
  const filter = auditFilter({ action: "job", jobId: "run_1", from: "2026-11-12", to: "2026-11-12" });
  expect(filter).toMatchObject({ action: "job", jobId: "run_1" });
  expect(new Date(filter.to!).getTime() - new Date(filter.from!).getTime()).toBe(86_400_000 - 1);
});

test("every action family has its words in English and French", () => {
  for (const lang of ["en", "fr"] as const) for (const f of AUDIT_FAMILIES) expect((resources[lang].audit.family as Record<string, string>)[f], `${lang} ${f}`).toBeTruthy();
});

test("the page's URL parameters keep valid filters and drop bad ones, impossible days included", async () => {
  const { Route } = await import("../../routes/_app.audit.tsx");
  const parse = (s: unknown) => (Route.options.validateSearch as { parse: (s: unknown) => unknown }).parse(s);
  expect(parse({ action: "job", jobId: "run_1", agentId: "agent_1", from: "2026-11-12", to: "2026-11-13", result: "ok", actorType: "user", resourceType: "table" })).toEqual({
    action: "job", jobId: "run_1", agentId: "agent_1", from: "2026-11-12", to: "2026-11-13", result: "ok", actorType: "user", resourceType: "table",
  });
  expect(parse({ action: "nope", result: "bad", actorType: "x", resourceType: "y", from: "2026-02-30", to: "yesterday", jobId: "x".repeat(201) })).toEqual({});
});
