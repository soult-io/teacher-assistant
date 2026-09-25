/**
 * Playwright config (scaffold).
 *
 * DEFAULT: build the PWA, serve its dist with `vite preview`, run chromium
 * against it. When E2E_BASE_URL is set (e.g. a live QA URL), no local server is
 * booted and the suite runs against that URL.
 *
 * The convergence/offline/para suites that need the real services land with the
 * Phase-0 spec; for now this proves the shell renders end to end.
 *
 * WALKTHROUGH MODE (E2E_WALKTHROUGH=1): a separate, NON-gating capture that re-runs the
 * J1–J6 journeys on chromium at human pace (slowMo per action, per-character typing, a
 * hold at the end of every step) purely to record a video a person can watch. It
 * writes its own evidence (walkthrough-evidence.json, for the step offsets into THIS
 * recording) under test-results-walkthrough/, so it can never mix with the gating
 * run's evidence. The default (gating) run below is unchanged and stays fast.
 */
import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import type { StepStillsOptions } from "./tests/support/journey";
import { PHONE } from "./tests/support/track";

const liveBaseUrl = process.env.E2E_BASE_URL;
const walkthrough = process.env.E2E_WALKTHROUGH === "1";

// The walkthrough records only the local synthetic-seed build. A live URL could serve
// real student data into a published video, so the combination is refused outright.
if (walkthrough && liveBaseUrl) {
  throw new Error("E2E_WALKTHROUGH records the local synthetic build only — unset E2E_BASE_URL");
}

// On CI every run's evidence (videos, traces, stills) is uploaded to PUBLIC Actions
// artifacts and may be built into the public dashboard image, so CI only ever tests the
// local synthetic build. A live URL is for a person running the suite by hand.
if (process.env.CI && liveBaseUrl) {
  throw new Error("E2E_BASE_URL is refused on CI — CI tests the local synthetic build only");
}

/** Walkthrough: pause Playwright adds before every browser action (ms). */
const WALKTHROUGH_SLOWMO_MS = 300;

// Stamped into the evidence so the dashboard can prove a walkthrough recording is of
// the same commit as the gating run it sits beside. Null off CI.
const commitSha = process.env.GITHUB_SHA ?? null;

/** The local vite-preview build both modes run against when no live URL is given. */
const LOCAL_URL = "http://127.0.0.1:4173";

const localServer: NonNullable<PlaywrightTestConfig["webServer"]> = {
  // Bind 127.0.0.1 explicitly: vite preview otherwise listens on
  // localhost/::1 in CI containers while Playwright polls the IPv4 URL
  // below, so the readiness check never resolves and the run times out.
  command:
    "pnpm --filter @teacher-assistant/pwa exec vite preview --host 127.0.0.1 --port 4173 --strictPort",
  url: LOCAL_URL,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
};

const walkthroughConfig = defineConfig<StepStillsOptions>({
  testDir: "./tests",
  // The journeys only — the smoke/layout specs have nothing to walk through.
  testMatch: /j\d-.*\.spec\.ts$/,
  outputDir: "./test-results-walkthrough",
  // Human pace multiplies each journey's wall time; the gating run keeps its 60s bound.
  timeout: 300_000,
  fullyParallel: false,
  workers: 1,
  // A recording, not a gate: a retry would only record the same journey twice.
  retries: 0,
  reporter: [
    [process.env.CI ? "github" : "list"],
    [
      "./reporters/evidence-reporter.ts",
      {
        outputFile: "test-results-walkthrough/walkthrough-evidence.json",
        mode: "walkthrough",
        commitSha,
        baseURL: LOCAL_URL,
      },
    ],
  ],
  use: {
    baseURL: LOCAL_URL,
    trace: "off",
    screenshot: "off",
    // Recorded at the phone viewport the journeys run in, 1:1, so the text in the
    // video is the size a teacher sees it — not a phone screen shrunk into a
    // desktop-shaped frame.
    video: { mode: "on", size: PHONE },
  },
  projects: [
    {
      name: "walkthrough",
      use: {
        ...devices["Desktop Chrome"],
        viewport: PHONE,
        walkthrough: true,
        launchOptions: { slowMo: WALKTHROUGH_SLOWMO_MS },
      },
    },
  ],
  webServer: localServer,
});

/** The origin the gating run tests; stamped into its evidence. */
const baseURL = liveBaseUrl ?? LOCAL_URL;

const gatingConfig = defineConfig<StepStillsOptions>({
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
        [
          "./reporters/evidence-reporter.ts",
          {
            outputFile: "test-results/journey-evidence.json",
            mode: "gating",
            commitSha,
            baseURL,
          },
        ],
        ["json", { outputFile: "test-results/results.json" }],
        ["html", { open: "never" }],
      ]
    : [["list"]],
  use: {
    baseURL,
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
  ...(liveBaseUrl ? {} : { webServer: localServer }),
});

export default walkthrough ? walkthroughConfig : gatingConfig;
