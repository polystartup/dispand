import js from "@eslint/js";
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
);
