/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "warn",
      comment:
        "Circular dependencies make code hard to reason about and refactor. " +
        "Break cycles by extracting shared types/helpers.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment:
        "Orphan modules (not reachable from any entry) are typically dead code. " +
        "Either wire them up or delete them.",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|cts|mts|json)$",
          "\\.d\\.ts$",
          "(^|/)tsconfig\\.json$",
          "(^|/)tsdown\\.config\\.(js|cjs|mjs|ts|cts|mts|json)$",
          "(^|/)src/lib/build-info\\.gen\\.ts$",
          "(^|/)src/pages/usage-viewer\\.gen\\.ts$",
          "(^|/)src/pages/.+",
        ],
      },
      to: {},
    },
    {
      name: "not-to-test",
      severity: "error",
      comment:
        "Production code should not depend on test fixtures or specs.",
      from: { pathNot: "^(tests|src/.+\\.test\\.ts$)" },
      to: { path: "^(tests|src/.+\\.test\\.ts$)" },
    },
    {
      name: "no-route-imports-from-lib-or-services",
      severity: "error",
      comment:
        "Layering rule per CLAUDE.md: routes -> services -> lib. " +
        "Modules under src/lib and src/services must not import from src/routes.",
      from: { path: "^src/(lib|services)/" },
      to: { path: "^src/routes/" },
    },
  ],
  options: {
    doNotFollow: {
      path: ["node_modules"],
    },
    tsConfig: {
      fileName: "tsconfig.json",
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/(?:@[^/]+/[^/]+|[^/]+)",
      },
      archi: {
        collapsePattern:
          "^(?:packages|src|lib|app|bin|test(?:s?)|spec(?:s?))/[^/]+|node_modules/(?:@[^/]+/[^/]+|[^/]+)",
      },
    },
  },
}
