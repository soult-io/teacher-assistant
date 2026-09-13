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
  },
});
