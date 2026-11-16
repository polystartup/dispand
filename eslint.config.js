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
    files: [
      "apps/web/src/components/shell/**/*.tsx",
      "apps/web/src/components/auth/**/*.tsx",
      "apps/web/src/components/settings/**/*.tsx",
      "apps/web/src/routes/_app.tsx",
      "apps/web/src/routes/login.tsx",
      "apps/web/src/routes/setup.tsx",
      "apps/web/src/routes/_app.settings.{tools,skills,plugins.*,harnesses.*}.tsx",
      "apps/web/src/components/{chat,assistant,questions,runs}/**/*.tsx",
      "apps/web/src/routes/_app.{assistant,inbox}.tsx",
      "apps/web/src/routes/_app.settings.workflows.runs.$runId.tsx",
      "apps/web/src/components/{memory,audit}/**/*.tsx",
      "apps/web/src/routes/_app.audit.tsx",
      "apps/web/src/routes/_app.settings.{agents.*,data.*,memory,workflows.index,workflows.$id}.tsx",
    ],
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
);
