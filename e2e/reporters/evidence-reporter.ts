// Journey-evidence reporter — the machine-readable step+assertion record the
// verification dashboard renders.
//
// WHY THIS EXISTS: Playwright's built-in JSON reporter prunes a GREEN run down to
// top-level `test.step` titles only — no nested `expect` sub-steps, no assertion
// text. But the reporter API DOES expose the full tree, and `expect(locator,
// "message")` surfaces that message verbatim as the `expect` step's title. So the
// evidence the dashboard needs (step labels + assertion text) is reachable ONLY
// through a custom reporter — never by hand-authoring it (that would defeat the
// whole point: nothing on a card exists unless a real run produced it).
//
// Product-agnostic on purpose: this emits raw Playwright shapes (test title path,
// project, status, attachments, step/assertion tree). The dashboard ENGINE maps
// these to journeys via a per-product manifest; nothing here knows about TRACK.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

// v2 adds steps[].screenshot (always present: a still record, or null = no still).
// Additive, still v2: optional top-level `mode` + `commitSha` (see EvidenceFile).
// v3: a still is full-height and its record carries `width`, `height` and `truncated`.
export const EVIDENCE_SCHEMA = "journey-evidence/3";

/** Which run produced the file: the fast gating run, or the human-pace walkthrough. */
export type EvidenceMode = "gating" | "walkthrough";

/**
 * Annotation the journey `step` fixture adds in walkthrough mode: the ISO instant of
 * the recording's first frame. Step offsets are measured from it, because a page's
 * video starts at its first paint, not at test start.
 */
export const RECORDING_START_ANNOTATION = "recording-start";

/** Attachment name the journey `step` fixture (tests/support/journey.ts) gives a step's still. */
export const STEP_STILL_ATTACHMENT = "step-still";

/** Attachment (JSON body, a StillMeta) the fixture adds right after each still. */
export const STEP_STILL_META_ATTACHMENT = "step-still-meta";

/** The still's pixel size, and whether the screen was cut off at the height cap. */
export interface StillMeta {
  width: number;
  height: number;
  /** True when part of the screen is not in the still (over the cap) — never silent. */
  truncated: boolean;
}

type AssertionStatus = "passed" | "failed";

interface AssertionRecord {
  text: string;
  status: AssertionStatus;
  detail?: string;
}

// A still with no readable meta is written without width/height/truncated: the
// dashboard's v3 ingest then fails loud instead of guessing "not cut off".
interface StillRecord extends Partial<StillMeta> {
  path: string;
  contentType: string;
}

interface StepRecord {
  label: string;
  durationMs: number;
  // Offset of this step's start into the recording, in ms: from the recording-start
  // annotation when the run stamped one (walkthrough), else from the test's start.
  // The dashboard uses it to place scrubber markers, seek to a step, and
  // auto-highlight the current step as the video plays.
  startOffsetMs: number;
  status: AssertionStatus;
  assertions: AssertionRecord[];
  // The full-height still attached at the end of this step, or null when the step has
  // none (a non-canonical browser, or a capture that failed). Never omitted, never a
  // placeholder: null is the explicit "no still".
  screenshot: StillRecord | null;
}

interface AttachmentRecord {
  name: string;
  contentType: string;
  path?: string;
}

interface TestRecord {
  titlePath: string[];
  title: string;
  file: string;
  line: number;
  project: string;
  status: TestResult["status"];
  outcome: ReturnType<TestCase["outcome"]>;
  durationMs: number;
  retries: number;
  startTime: string;
  errors: string[];
  attachments: AttachmentRecord[];
  steps: StepRecord[];
}

interface EvidenceFile {
  schema: typeof EVIDENCE_SCHEMA;
  // The dashboard only plays a walkthrough video from a file that says it is one, and
  // only when its commit equals the gating run's — so a stale or swapped recording
  // can never be shown as this commit's.
  mode: EvidenceMode;
  commitSha: string | null;
  generatedAt: string;
  stats: {
    expected: number;
    unexpected: number;
    flaky: number;
    skipped: number;
    durationMs: number;
    startTime: string;
  };
  tests: TestRecord[];
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI colour codes from error text.
const ANSI = /\[[0-9;]*m/g;

function cleanError(text: string | undefined): string {
  return (text ?? "").replace(ANSI, "").trim();
}

/** Assertions are the `expect` steps beneath a `test.step`. Recurse through plain
 * containers but stop at nested `test.step`s (a 3b concern — the journey suites are
 * flat today), so an expect is attributed to exactly one step. */
function collectAssertions(steps: TestStep[]): AssertionRecord[] {
  const out: AssertionRecord[] = [];
  for (const step of steps) {
    if (step.category === "expect") {
      const failed = Boolean(step.error);
      out.push({
        text: step.title,
        status: failed ? "failed" : "passed",
        ...(failed ? { detail: cleanError(step.error?.message) } : {}),
      });
    } else if (step.category !== "test.step" && step.steps.length > 0) {
      out.push(...collectAssertions(step.steps));
    }
  }
  return out;
}

/** The fixture's StillMeta attachment body, or null when it is missing or malformed. */
function readStillMeta(body: Buffer | undefined): StillMeta | null {
  if (!body) return null;
  try {
    const m = JSON.parse(body.toString("utf8")) as Partial<StillMeta>;
    if (
      Number.isInteger(m.width) &&
      Number.isInteger(m.height) &&
      typeof m.truncated === "boolean"
    ) {
      return { width: m.width as number, height: m.height as number, truncated: m.truncated };
    }
  } catch {
    // Unreadable: treated as absent (see StillRecord).
  }
  return null;
}

/** Fold one attachment into the still seen so far: a new still, or the meta for it. */
function withAttachment(
  still: StillRecord | null,
  a: TestStep["attachments"][number],
): StillRecord | null {
  if (a.name === STEP_STILL_ATTACHMENT && a.path) {
    return { path: a.path, contentType: a.contentType };
  }
  if (a.name === STEP_STILL_META_ATTACHMENT && still) {
    const meta = readStillMeta(a.body);
    if (meta) return { ...still, ...meta };
  }
  return still;
}

/** The step's own still: attached by a direct child (`test.attach`), not by a nested
 * `test.step` (that one belongs to the nested step). The last one wins — the wrapper
 * attaches exactly one per step, at the step's end, followed by its meta. */
function findStill(steps: TestStep[]): StillRecord | null {
  let still: StillRecord | null = null;
  for (const step of steps) {
    if (step.category === "test.step") continue;
    for (const a of step.attachments) still = withAttachment(still, a);
    const nested = findStill(step.steps);
    if (nested) still = nested;
  }
  return still;
}

function collectSteps(steps: TestStep[], originMs: number): StepRecord[] {
  const out: StepRecord[] = [];
  for (const step of steps) {
    if (step.category !== "test.step") continue;
    out.push({
      label: step.title,
      durationMs: Math.round(step.duration),
      startOffsetMs: Math.max(0, Math.round(step.startTime.getTime() - originMs)),
      status: step.error ? "failed" : "passed",
      assertions: collectAssertions(step.steps),
      screenshot: findStill(step.steps),
    });
  }
  return out;
}

/** Where step offsets are measured from: the stamped recording start, else test start. */
function offsetOrigin(result: TestResult): number {
  const stamp = result.annotations.find((a) => a.type === RECORDING_START_ANNOTATION);
  const ms = stamp?.description ? Date.parse(stamp.description) : Number.NaN;
  return Number.isNaN(ms) ? result.startTime.getTime() : ms;
}

function toRecord(test: TestCase, result: TestResult): TestRecord {
  const attachments: AttachmentRecord[] = result.attachments.map((a) => ({
    name: a.name,
    contentType: a.contentType,
    ...(a.path ? { path: a.path } : {}),
  }));
  return {
    titlePath: test.titlePath(),
    title: test.title,
    file: test.location.file,
    line: test.location.line,
    project: test.parent.project()?.name ?? test.titlePath()[1] ?? "",
    status: result.status,
    outcome: test.outcome(),
    durationMs: Math.round(result.duration),
    retries: result.retry,
    startTime: result.startTime.toISOString(),
    errors: result.errors.map((e) => cleanError(e.message)).filter(Boolean),
    attachments,
    steps: collectSteps(result.steps, offsetOrigin(result)),
  };
}

/**
 * Records the FINAL attempt of every test (the passing retry for a flaky test) as a
 * self-contained evidence file. Self-contained on purpose: results.json carries no
 * per-test id to join against, so the engine reads this one file.
 */
export default class EvidenceReporter implements Reporter {
  private readonly outputFile: string;
  private readonly mode: EvidenceMode;
  private readonly commitSha: string | null;
  // Keyed by test.id → the highest-retry (final) result seen for that test.
  private readonly finals = new Map<string, { test: TestCase; result: TestResult }>();

  constructor(
    options: { outputFile?: string; mode?: EvidenceMode; commitSha?: string | null } = {},
  ) {
    this.outputFile = resolve(options.outputFile ?? "test-results/journey-evidence.json");
    this.mode = options.mode ?? "gating";
    this.commitSha = options.commitSha ?? null;
  }

  onBegin(_config: FullConfig, _suite: Suite): void {
    this.finals.clear();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const prev = this.finals.get(test.id);
    if (!prev || result.retry >= prev.result.retry) {
      this.finals.set(test.id, { test, result });
    }
  }

  onEnd(result: FullResult): void {
    const tests = [...this.finals.values()].map(({ test, result: r }) => toRecord(test, r));
    const stats = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
    for (const t of tests) {
      if (t.outcome === "expected") stats.expected++;
      else if (t.outcome === "unexpected") stats.unexpected++;
      else if (t.outcome === "flaky") stats.flaky++;
      else if (t.outcome === "skipped") stats.skipped++;
    }
    const evidence: EvidenceFile = {
      schema: EVIDENCE_SCHEMA,
      mode: this.mode,
      commitSha: this.commitSha,
      generatedAt: new Date().toISOString(),
      stats: {
        ...stats,
        durationMs: Math.round(result.duration),
        startTime: result.startTime.toISOString(),
      },
      tests,
    };
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
