/**
 * Playwright config (scaffold).
 *
 * DEFAULT: build the PWA, serve its dist with `vite preview`, run chromium
 * against it. When E2E_BASE_URL is set (e.g. a live QA URL), no local server is
 * booted and the suite runs against that URL.
 *
 * The convergence/offline/para suites that need the real services land with the
 * Phase-0 spec; for now this proves the shell renders end to end.
 */
import { defineConfig, devices } from "@playwright/test";

const liveBaseUrl = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // JSON reporter (results.json) is the machine-readable evidence the verification
  // pipeline consumes; github + html are the human-facing views. All land under
  // test-results/ (outputFile below + the default outputDir) so one artifact upload
  // captures results.json alongside the per-test videos and traces.
  reporter: process.env.CI
    ? [
        ["github"],
        ["json", { outputFile: "test-results/results.json" }],
        ["html", { open: "never" }],
      ]
    : [["list"]],
  use: {
    baseURL: liveBaseUrl ?? "http://127.0.0.1:4173",
    // Full trace + video on every test: these ARE the journey evidence the
    // dashboard renders, not just failure diagnostics. Screenshots stay
    // failure-only — video + trace already cover the passing path.
    trace: "on",
    video: "on",
    screenshot: "only-on-failure",
  },
  // Cross-browser proof: every journey runs on Chromium and Firefox. Kept serial
  // (workers 1 / fullyParallel false) so evidence capture stays deterministic.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  ...(liveBaseUrl
    ? {}
    : {
        webServer: {
          // Bind 127.0.0.1 explicitly: vite preview otherwise listens on
          // localhost/::1 in CI containers while Playwright polls the IPv4 URL
          // below, so the readiness check never resolves and the run times out.
          command:
            "pnpm --filter @teacher-assistant/pwa exec vite preview --host 127.0.0.1 --port 4173 --strictPort",
          url: "http://127.0.0.1:4173",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
});
