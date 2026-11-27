import js from "@eslint/js";
import betterTailwindcss from "eslint-plugin-better-tailwindcss";
import i18next from "eslint-plugin-i18next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/** At most this many parameters: past it, a function takes an options object. */
const MAX_PARAMS = 5;
/** At most this many lines in a function, blank lines and comments aside. Tests aside: a test reads top to bottom. */
const MAX_FUNCTION_LINES = 150;
const longFunctions = (max) => ["error", { max, skipBlankLines: true, skipComments: true }];

// What was already past those limits when they came, each file capped at its worst then: it may
// shrink, never grow. In config rather than inline, so a fix never leaves a directive `lint` refuses.
const PARAMS_NOW = {
  "apps/runner/src/mcp.ts": 6,
  "apps/web/src/components/data/row-writes.ts": 6,
  "packages/domain/src/agents/tool-ask.ts": 6,
  "packages/domain/src/assistant/review.ts": 6,
  "packages/domain/src/audit/list.ts": 6,
  "packages/domain/src/data/rows.ts": 6,
  "packages/domain/src/engine/engine.ts": 7,
  "packages/domain/src/engine/scheduler.ts": 6,
  "packages/domain/src/engine/step-rows.ts": 6,
  "packages/domain/src/memory/store.ts": 10,
  "packages/domain/src/platform/call.ts": 6,
  "packages/domain/src/plugins/resolve.ts": 6,
  "packages/domain/src/plugins/table-apply.ts": 6,
  "packages/domain/src/plugins/uninstall-procedures.ts": 6,
  "packages/domain/src/plugins/update.ts": 6,
  "packages/domain/src/tools/mcp.ts": 6,
  "packages/domain/src/tools/pollable.ts": 6,
};
const FUNCTION_LINES_NOW = {
  "apps/runner/src/claude.ts": 503,
  "apps/runner/src/codex/session.ts": 481,
  "apps/runner/src/main.ts": 260,
  "apps/runner/src/plugins.ts": 177,
  "apps/runner/src/sandbox/worker.ts": 153,
  "apps/runner/src/sessions.ts": 327,
  "apps/web/src/components/agents/PollTriggerPanel.tsx": 165,
  "apps/web/src/components/agents/TriggerSheet.tsx": 264,
  "apps/web/src/components/data/Grid.tsx": 352,
  "apps/web/src/components/settings/AgentEditor.tsx": 361,
  "apps/web/src/components/settings/CloudHarnessForm.tsx": 202,
  "apps/web/src/components/settings/HarnessSheet.tsx": 173,
  "apps/web/src/components/settings/PluginInstallSheet.tsx": 300,
  "apps/web/src/components/settings/PluginRow.tsx": 268,
  "apps/web/src/components/settings/RunnerToolSheet.tsx": 199,
  "apps/web/src/components/settings/SkillEditor.tsx": 174,
  "apps/web/src/components/settings/ToolSheet.tsx": 280,
  "apps/web/src/components/widgets/ChatSessionHost.tsx": 213,
  "apps/web/src/components/workflow/Canvas.tsx": 157,
  "apps/web/src/components/workflow/panels/ScheduleTriggerPanel.tsx": 209,
  "apps/web/src/routes/-invitation.tsx": 157,
  "apps/web/src/routes/_app.settings.workflows.$id.tsx": 215,
  "packages/domain/src/engine/engine.ts": 216, // 173 before formatting wrapped `apply`'s lines
  "packages/domain/src/platform/proposals.ts": 169, // 150 before formatting wrapped `itemsView`'s lines
  "packages/domain/src/plugins/closure.ts": 235,
  "packages/domain/src/plugins/setup.ts": 286,
  "packages/domain/src/tools/oauth-provider.ts": 159,
};

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
  // Small functions and few parameters: a long one is split, many parameters become an options object.
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: { "max-params": ["error", MAX_PARAMS], "max-lines-per-function": longFunctions(MAX_FUNCTION_LINES) },
  },
  { files: ["**/*.test.ts", "**/*.test.tsx", "apps/web/e2e/**"], rules: { "max-lines-per-function": "off" } },
  ...Object.entries(PARAMS_NOW).map(([file, max]) => ({ files: [file], rules: { "max-params": ["error", max] } })),
  ...Object.entries(FUNCTION_LINES_NOW).map(([file, max]) => ({ files: [file], rules: { "max-lines-per-function": longFunctions(max) } })),
);
