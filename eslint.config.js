import js from "@eslint/js";
import i18next from "eslint-plugin-i18next";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.output/**", "**/node_modules/**", "**/routeTree.gen.ts", "**/drizzle/**", "apps/runner/src/codex/protocol/**", "**/test-results/**", "**/playwright-report/**", ".superpowers/**", ".worktrees/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // OpenTelemetry's SDK is known to one module only (`packages/domain/src/telemetry/`), which
  // owns redaction: nothing reaches an exporter without going through it.
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["packages/domain/src/telemetry/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [{ group: ["@opentelemetry/*"], message: "Use packages/domain/src/telemetry: it owns the SDK and redaction." }] }] },
  },
  // Translated areas: a user-visible literal in JSX text or in the attributes people read fails;
  // its text belongs in `apps/web/src/locales/`. Add an area here once it is translated.
  {
    files: ["apps/web/src/components/shell/**/*.tsx", "apps/web/src/routes/_app.tsx"],
    ignores: ["**/*.test.tsx"],
    plugins: { i18next },
    rules: {
      "i18next/no-literal-string": [
        "error",
        {
          mode: "jsx-only",
          "jsx-attributes": { include: ["placeholder", "aria-label", "title", "alt"] },
          // Punctuation and symbols alone, besides the plugin's ASCII ones.
          words: { exclude: ["Dispand", "[0-9!-/:-@[-`{-~·…—–→×✓\\s]+", "[A-Z_-]+"] },
        },
      ],
    },
  },
);
