import js from "@eslint/js";
import betterTailwindcss from "eslint-plugin-better-tailwindcss";
import i18next from "eslint-plugin-i18next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.output/**",
      "**/node_modules/**",
      "**/routeTree.gen.ts",
      "**/drizzle/**",
      "apps/runner/src/codex/protocol/**",
      "**/test-results/**",
      "**/playwright-report/**",
      ".superpowers/**",
      ".worktrees/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // OpenTelemetry's SDK is known to one module only (`packages/domain/src/telemetry/`), which
  // owns redaction: nothing reaches an exporter without going through it.
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["packages/domain/src/telemetry/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@opentelemetry/*"], message: "Use packages/domain/src/telemetry: it owns the SDK and redaction." }] },
      ],
    },
  },
  // Translated areas: a user-visible literal in JSX text or in the attributes people read fails;
  // its text belongs in `apps/web/src/locales/`. All of apps/web/src, tests apart.
  {
    files: ["apps/web/src/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
    plugins: { i18next },
    rules: {
      "i18next/no-literal-string": [
        "error",
        {
          mode: "jsx-only",
          "jsx-attributes": { include: ["placeholder", "aria-label", "title", "alt"] },
          // Product names, and punctuation or symbols alone (besides the plugin's ASCII ones).
          words: { exclude: ["Dispand", "Claude Code", "Codex", "[0-9!-/:-@[-`{-~·…—–→×✓\\s]+", "[A-Z_-]+"] },
        },
      ],
    },
  },
  // The Rules of Hooks, and React Compiler's checks of what a component does while it renders.
  { ...reactHooks.configs.flat.recommended, files: ["apps/web/src/**/*.{ts,tsx}"] },
  // Accessibility of the page's markup, tests apart.
  {
    ...jsxA11y.flatConfigs.recommended,
    files: ["apps/web/src/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // `Check`'s label text sits in a span within a span: one level more than the default.
      "jsx-a11y/label-has-associated-control": ["error", { depth: 3 }],
    },
  },
  // A class Tailwind doesn't know makes no CSS (`bg-surface-2` didn't). Read from apps/web's own
  // Tailwind and entry CSS, so its tokens are known: without `cwd` the rule finds no Tailwind at
  // the root and turns itself off, with only a warning.
  {
    files: ["apps/web/src/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
    plugins: { "better-tailwindcss": betterTailwindcss },
    settings: { "better-tailwindcss": { cwd: "apps/web", entryPoint: "src/styles.css" } },
    rules: {
      "better-tailwindcss/no-unknown-classes": [
        "error",
        // Plain CSS of `styles.css`, and the names React Flow (nodrag, nopan) and the dashboard's
        // drag handle (widget-drag) look for.
        { ignore: ["^spectrum-header$", "^dashboard-editing$", "^nodrag$", "^nopan$", "^widget-drag$"] },
      ],
    },
  },
);
