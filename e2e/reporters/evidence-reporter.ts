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

export const EVIDENCE_SCHEMA = "journey-evidence/1";

type AssertionStatus = "passed" | "failed";

interface AssertionRecord {
  text: string;
  status: AssertionStatus;
  detail?: string;
}

interface StepRecord {
  label: string;
  durationMs: number;
  status: AssertionStatus;
  assertions: AssertionRecord[];
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

function collectSteps(steps: TestStep[]): StepRecord[] {
  const out: StepRecord[] = [];
  for (const step of steps) {
    if (step.category !== "test.step") continue;
    out.push({
      label: step.title,
      durationMs: Math.round(step.duration),
      status: step.error ? "failed" : "passed",
      assertions: collectAssertions(step.steps),
    });
  }
  return out;
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
    steps: collectSteps(result.steps),
  };
}

/**
 * Records the FINAL attempt of every test (the passing retry for a flaky test) as a
 * self-contained evidence file. Self-contained on purpose: results.json carries no
 * per-test id to join against, so the engine reads this one file.
 */
export default class EvidenceReporter implements Reporter {
  private readonly outputFile: string;
  // Keyed by test.id → the highest-retry (final) result seen for that test.
  private readonly finals = new Map<string, { test: TestCase; result: TestResult }>();

  constructor(options: { outputFile?: string } = {}) {
    this.outputFile = resolve(options.outputFile ?? "test-results/journey-evidence.json");
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
