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
import type { StepStillsOptions } from "./tests/support/journey";

const liveBaseUrl = process.env.E2E_BASE_URL;

export default defineConfig<StepStillsOptions>({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // journey-evidence.json (our custom reporter) is the step+assertion evidence the
  // verification dashboard renders — the built-in JSON reporter prunes green runs to
  // bare test.step titles, so it cannot supply assertion text. results.json stays for
  // stats/tooling; github + html are the human-facing views. All land under
  // test-results/ (outputFile paths + the default outputDir) so one artifact upload
  // captures the evidence alongside the per-test videos and traces.
  reporter: process.env.CI
    ? [
        ["github"],
        ["./reporters/evidence-reporter.ts", { outputFile: "test-results/journey-evidence.json" }],
        ["json", { outputFile: "test-results/results.json" }],
        ["html", { open: "never" }],
      ]
    : [["list"]],
  use: {
    baseURL: liveBaseUrl ?? "http://127.0.0.1:4173",
    // Full trace + video on every test: these ARE the journey evidence the
    // dashboard renders, not just failure diagnostics. Screenshots stay
    // failure-only here — the per-step stills come from the journey `step` fixture.
    trace: "on",
    video: "on",
    screenshot: "only-on-failure",
  },
  // Cross-browser proof: every journey runs on Chromium and Firefox. Kept serial
  // (workers 1 / fullyParallel false) so evidence capture stays deterministic.
  // Per-step stills are taken on the canonical browser (chromium) only — the
  // dashboard shows one browser's walkthrough, so the second capture is pure cost.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], stepStills: true } },
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
