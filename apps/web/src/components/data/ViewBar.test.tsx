// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";
import { createI18n } from "../../lib/i18n.ts";
import { ViewBar } from "./ViewBar.tsx";

afterEach(cleanup);

const fields = [{ id: "f_name", name: "Nom", type: "text" as const, choices: [] }];

test("the view bar is in French, with plural row counts", () => {
  const view = (shown: number, total: number, filters: { fieldId: string; op: "contains"; value: string }[]) => (
    <I18nextProvider i18n={createI18n("fr")}>
      <ViewBar fields={fields} query={{ filters, sort: [{ fieldId: "f_name", dir: "asc" }] }} onChange={vi.fn()} shown={shown} total={total} />
    </I18nextProvider>
  );
  const { rerender } = render(view(1, 1, []));
  expect(screen.getByRole("button", { name: "Trier (1)" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Filtrer" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("1 ligne");
  rerender(view(2, 5, [{ fieldId: "f_name", op: "contains", value: "a" }]));
  expect(screen.getByRole("button", { name: "Filtrer (1)" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("2 sur 5 lignes");
});
