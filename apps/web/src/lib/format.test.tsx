// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test } from "vitest";
import { useFormat } from "./format.ts";
import { createI18n } from "./i18n.ts";

afterEach(cleanup);

function Sample() {
  const format = useFormat();
  return <p>{`${format.date(new Date(2026, 0, 15), { dateStyle: "long" })} | ${format.number(1234.5)}`}</p>;
}

test("with French chosen on an English browser, a date and a number render in French", () => {
  expect(navigator.language).toMatch(/^en/);
  render(<I18nextProvider i18n={createI18n("fr")}><Sample /></I18nextProvider>);
  expect(screen.getByText(/janvier/).textContent).toBe("15 janvier 2026 | 1 234,5");
});

test("in English, the same date and number render in English", () => {
  render(<I18nextProvider i18n={createI18n("en")}><Sample /></I18nextProvider>);
  expect(screen.getByText(/January/).textContent).toBe("January 15, 2026 | 1,234.5");
});
