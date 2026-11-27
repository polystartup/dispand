import tseslint from "typescript-eslint";
import base from "./eslint.config.js";

// `pnpm lint:types`: eslint.config.js plus the rules that need TypeScript's types, a CI job of its
// own. Building the programs takes minutes, so `pnpm lint` stays without them. It lints one package
// at a time: the four programs together pass Node's default heap.
export default tseslint.config(
  ...base,
  {
    files: ["**/*.ts", "**/*.tsx"],
    // Built against the packed packages, outside the repository (check.sh): no tsconfig here has it.
    ignores: ["apps/web/package-check/**"],
    extends: [tseslint.configs.recommendedTypeCheckedOnly],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-deprecated": [
        "error",
        {
          allow: [
            // MCP servers that speak only the older SSE transport are still around: the owner picks it.
            { from: "package", package: "@modelcontextprotocol/client", name: "SSEClientTransport" },
            // The low-level server: it shows a tool's JSON Schema as it is, where McpServer wants Zod.
            { from: "package", package: "@modelcontextprotocol/server", name: "Server" },
            // OpenAI-compatible servers know `max_tokens`; many don't know `max_completion_tokens`.
            { from: "package", package: "openai", name: "max_tokens" },
            // Experimental, so marked deprecated, with no stable replacement yet.
            { from: "package", package: "@assistant-ui/react", name: ["unstable_useSlashCommandAdapter", "unstable_useTriggerPopoverRootContext"] },
          ],
        },
      ],
      // Rethrowing what was caught (unknown), or an abort's reason, keeps the error as it came.
      "@typescript-eslint/prefer-promise-reject-errors": ["error", { allowThrowingAny: true, allowThrowingUnknown: true }],
      // `as never` and `as unknown` are deliberate escapes, which the rule calls unnecessary where a
      // generic infers its type from them (`t(key as never)`, `vi.hoisted(() => ({ e: x as unknown }))`).
      // `as typeof fetch`: apps/web compiles domain's sources with the DOM's `fetch`, which needs it.
      "@typescript-eslint/no-unnecessary-type-assertion": ["error", { typesToIgnore: ["never", "unknown", "typeof fetch"] }],
      // TanStack Router's `redirect()` is thrown, by design.
      "@typescript-eslint/only-throw-error": ["error", { allow: [{ from: "package", package: "@tanstack/router-core", name: "Redirect" }] }],
      // An `async` function without `await` still turns a throw into a rejection, and gives the
      // Promise its interface asks for (a fake, a handler): dropping `async` would change both.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "apps/web/e2e/**/*.spec.ts"],
    rules: {
      // Vitest's asymmetric matchers (`expect.any`) and mock calls, and Playwright's `json()`, are
      // `any` by design.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Tests hand fakes' methods around (`onTestFinished(server.close)`) and stringify sockets'
      // messages: one that needs its `this`, or prints `[object Object]`, fails its test.
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-base-to-string": "off",
    },
  },
);
