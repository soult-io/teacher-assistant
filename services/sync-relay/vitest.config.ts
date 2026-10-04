import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // PGlite (in-process Postgres) runs initdb per data dir: ~1.5 s each locally,
    // slower on a shared CI runner. The restart tests create two.
    testTimeout: 30_000,
  },
});
