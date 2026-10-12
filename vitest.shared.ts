import { defineConfig } from "vitest/config";

// Single source of truth for the node-package vitest config. Every pure-logic
// package (domain-core, store, sync, crypto, auth, schema) has the SAME test
// setup + coverage policy, so they re-export this rather than each carrying a
// byte-identical copy — Phase 2 flips coverage from measure-only to a threshold
// in ONE place, and the pattern ports to other repos (e.g. payroll) as one file
// plus thin re-exports.
//
// Relative globs and reportsDirectory resolve against each importing package's
// root (vitest runs per-package), so "./coverage" lands in that package's dir.
// apps/pwa keeps its own config: jsdom + the react plugin + service-worker/
// bootstrap excludes make it legitimately different.
export const nodeVitestConfig = defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Coverage baseline — measure-only, no failing threshold yet (Phase 1).
    // json-summary emits coverage-summary.json (what the verification pipeline
    // reads); json emits the full map for later drill-down.
    coverage: {
      provider: "v8",
      reporter: ["json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
