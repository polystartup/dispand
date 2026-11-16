// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test } from "vitest";
import { formatters, useFormat } from "./format.ts";
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

test("a list reads as one phrase in the page's language, with three items too", () => {
  expect(formatters("en").list(["a", "b", "c"])).toBe("a, b, and c");
  expect(formatters("fr").list(["a", "b", "c"])).toBe("a, b et c");
});

test("a choice reads with or, and a duration in the page's units", () => {
  expect(formatters("en").listOr(["a", "b", "c"])).toBe("a, b, or c");
  expect(formatters("fr").listOr(["a", "b"])).toBe("a ou b");
  function Elapsed() {
    const { duration } = useFormat();
    return <p>{[duration(new Date(0), new Date(5000)), duration(new Date(0), new Date(184000)), duration(new Date(0), new Date(3720000))].join("|")}</p>;
  }
  render(<I18nextProvider i18n={createI18n("fr")}><Elapsed /></I18nextProvider>);
  expect(screen.getByText(/min/).textContent).toBe("5 s|3 min 4 s|1 h 2 min");
});
