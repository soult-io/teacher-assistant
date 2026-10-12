import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Test config is kept separate from vite.config.ts so the PWA/service-worker
// plugin never runs under vitest. jsdom + fake-indexeddb back the component and
// ciphertext-persistence tests; the setup file wires jest-dom matchers and the
// in-memory IndexedDB.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Coverage baseline — measure-only, no failing threshold yet (Phase 1).
    // json-summary emits coverage-summary.json (what the verification pipeline
    // reads); json emits the full map. sw.ts (service-worker globals), the
    // main.tsx bootstrap, and test scaffolding are excluded — they are not unit
    // logic and instrumenting them under jsdom is noise.
    coverage: {
      provider: "v8",
      reporter: ["json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.d.ts",
        "src/sw.ts",
        "src/main.tsx",
        "src/test/**",
      ],
    },
  },
});
