// Import cycles, run by `pnpm run lint`. A cycle counts only through value imports: an `import
// type` is gone once built, and a module may well name the types of one that imports it.
// Production code only: tests and their helpers (`*.test.*`, `test-support.ts`, `test-*.ts`,
// `e2e/`) are left out of the graph, so a cycle among test helpers doesn't fail lint.
export default {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Modules that import each other's values: which one runs first decides what the other sees. Move what they share into a module both import.",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: [
        "/(dist|node_modules|\\.output|drizzle)/|routeTree\\.gen\\.ts$|^apps/runner/src/codex/protocol/",
        "\\.test\\.[cm]?[jt]sx?$|/test-[^/]*\\.ts$|/test-support\\.ts$|^apps/web/e2e/",
      ],
    },
    tsPreCompilationDeps: true,
    // For apps/web's `@/` paths; the other packages have none.
    tsConfig: { fileName: "apps/web/tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "default"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".json"],
    },
  },
};
