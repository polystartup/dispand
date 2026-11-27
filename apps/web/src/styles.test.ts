// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compile } from "tailwindcss";
import { expect, test } from "vitest";

test("dark: applies exactly where the dark tokens do: the user menu's choice, else the system's", async () => {
  // The app's own stylesheets; the packages' hold no theme condition, so they load empty and
  // `@tailwind utilities` stands in for tailwindcss's.
  const css = await compile(`${readFileSync(join(import.meta.dirname, "styles.css"), "utf8")}\n@tailwind utilities;`, {
    base: import.meta.dirname,
    loadStylesheet: async (id, base) => {
      const path = join(base, id);
      return id.startsWith(".") ? { path, base: dirname(path), content: readFileSync(path, "utf8") } : { path: id, base, content: "" };
    },
  });
  // The destructive button's own `dark:` utility: Tailwind's scan of the app reads tests too, so a
  // class only this test used would ship in the app's stylesheet.
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = css.build(["dark:bg-destructive/60"]);
  const probe = document.body.appendChild(document.createElement("p"));
  probe.className = "dark:bg-destructive/60";
  const root = document.documentElement;
  const dark: string[] = [];
  for (const system of ["light", "dark"]) {
    // jsdom evaluates no media query: the system's scheme is picked here.
    const rules = [...style.sheet!.cssRules]
      .flatMap((r) => (r instanceof CSSMediaRule ? (r.conditionText === `(prefers-color-scheme: ${system})` ? [...r.cssRules] : []) : [r]))
      .filter((r) => r instanceof CSSStyleRule);
    for (const choice of [undefined, "light", "dark"]) {
      const state = `${system} system, ${choice ?? "no"} choice`;
      if (choice) root.dataset.theme = choice;
      else delete root.dataset.theme;
      const tokensDark = rules.some((r) => r.style.getPropertyValue("color-scheme") === "dark" && root.matches(r.selectorText));
      const variantDark = rules.some((r) => r.style.getPropertyValue("background-color") !== "" && probe.matches(r.selectorText));
      expect({ state, variantDark }).toEqual({ state, variantDark: tokensDark });
      if (tokensDark) dark.push(state);
    }
  }
  // The tokens' own conditions, which also fails the test if no rule was read at all.
  expect(dark).toEqual(["light system, dark choice", "dark system, no choice", "dark system, dark choice"]);
});
