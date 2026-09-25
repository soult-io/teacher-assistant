// Orchestrator: assemble the live verification dashboard from a per-product config +
// the engine. Thin on purpose — every product-agnostic mechanic (counts, CI pills,
// journey ingest, rendering) lives in engine/; every product string (suites,
// workflows, journey manifest, branding, page sections) lives in config/. Swap the config
// import and the same engine renders another product.
//
//   engine counts + CI (config-driven)  +  journey-evidence.json (ingest)
//     + walkthrough-evidence.json (the human-pace recording of the same commit)
//   -> Journey[] + tiles/bars -> engine/template.html -> <outDir>/index.html
//      + videos/*.webm (walkthrough + raw gating) + traces/*.zip + stills/*.jpg
//
// The visual proof of each journey is the run's own video + per-step stills (both
// ingested from the e2e artifacts — the stills are taken by the e2e run itself), so
// there is no separate screenshot capture step: this generator needs no browser and
// no preview server.
//
// Before anything is written: the evidence must come from a run of the local synthetic
// build (checkRunOrigin), and everything the page is built from — plus the page itself —
// must pass the output scan (engine/pii-scan.mjs). Either failing refuses the whole
// build: no dist-dashboard, non-zero exit. The image and the Actions artifacts are public.
//
// Assumes `pnpm -r run build` has run (the workflow does this first).
// Usage: node src/generate.mjs [outDir]   (EVIDENCE_FILE env overrides the evidence path)

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createByteBudget, makeAssetResolver } from "../engine/assets.mjs";
import { collectCiPills } from "../engine/ci-status.mjs";
import { collectPackageCounts, deriveE2eCount } from "../engine/counts.mjs";
import {
  buildJourneys,
  checkRunOrigin,
  parseEvidence,
  parseWalkthroughEvidence,
} from "../engine/ingest.mjs";
import { formatFindings, scanBuild } from "../engine/pii-scan.mjs";
import { buildRunProvenance, sha256Hex } from "../engine/provenance.mjs";
import {
  aggregate,
  escapeHtml,
  fillTemplate,
  renderBars,
  renderCallouts,
  renderCiPills,
  renderSection,
  renderTiles,
} from "../engine/render/lib.mjs";
import { renderJourneyList } from "../engine/render/journeys.mjs";
import * as config from "../config/teacher-assistant/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = resolve(HERE, "..");
const ENGINE_DIR = join(TOOL_DIR, "engine");
const REPO_ROOT = resolve(TOOL_DIR, "..", "..");
const DEFAULT_EVIDENCE = join(REPO_ROOT, "e2e", "test-results", "journey-evidence.json");
const OUT_DIR = resolve(process.argv[2] ?? join(REPO_ROOT, "dist-dashboard"));

const passOf = (pkgs, name) => pkgs.find((p) => p.name === name)?.pass ?? 0;

// The full sha of the commit this page is built from — the TESTED commit. The CI
// wiring exports it as COMMIT_SHA (and also sets GITHUB_SHA to it for the generate
// step, since under workflow_run GITHUB_SHA is main's tip, not the tested commit).
// Locally: the checkout's HEAD. The header shows it short; the CI pills bind to it
// in full.
function commitSha() {
  const sha = process.env.COMMIT_SHA || process.env.GITHUB_SHA;
  if (sha) return sha;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return null;
  }
}

function buildMetrics(pkgs, e2eCount) {
  const { unitTotal, fileTotal, pkgCount } = aggregate(pkgs);
  return {
    unitTotal,
    fileTotal,
    pkgCount,
    ferpaCount: passOf(pkgs, config.ferpaPackage),
    e2eCount,
    engineCount: passOf(pkgs, config.enginePackage),
    pwaCount: passOf(pkgs, config.pwaPackage),
  };
}

// Read the evidence bytes, or null if the file is simply absent. A MISSING file is
// the designed degraded state (no run → every journey UNVERIFIED) and must not crash
// — e.g. the first dashboard build before an e2e run with the reporter reaches main.
// A CORRUPT file still fails loud downstream (parseEvidence), never a silent zero.
function readEvidenceBytes(evidenceFile, absentMeans = "every journey renders UNVERIFIED") {
  try {
    return readFileSync(evidenceFile);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.warn(`  no evidence at ${evidenceFile} — ${absentMeans}`);
      return null;
    }
    throw err;
  }
}

/**
 * Is this evidence of the local synthetic build? A stamped file naming another origin
 * throws (checkRunOrigin). A file from before the stamp (v1–v3) is refused when
 * publishing; on a PR/dispatch build it is not ingested (its journeys render
 * UNVERIFIED and none of its media is copied), so a PR opened before main has a v4 run
 * still builds.
 */
function admitEvidence(evidence, what) {
  if (checkRunOrigin(evidence, config.evidenceBaseUrl)) return true;
  if (process.env.PUBLISH === "true") {
    throw new Error(`${what} (${evidence.schema}) has no origin stamp — refusing to publish`);
  }
  console.warn(`  ${what} (${evidence.schema}) has no origin stamp — not ingested`);
  return false;
}

// The human-pace walkthrough run (non-gating). Absent → every card shows "no
// walkthrough recorded for this commit"; its videos are never replaced by the gating
// run's. Its assets count against the same published-bytes budget as the gating run's.
function loadWalkthrough(outDir, budget) {
  const file = process.env.WALKTHROUGH_EVIDENCE_FILE;
  if (!file) {
    console.warn("  no walkthrough evidence given — cards show no video");
    return null;
  }
  const path = resolve(file);
  const bytes = readEvidenceBytes(path, "no walkthrough: cards show no video");
  if (!bytes) return null;
  const evidence = parseWalkthroughEvidence(bytes.toString("utf8"));
  if (!admitEvidence(evidence, "walkthrough evidence")) return null;
  console.log(`  walkthrough evidence for commit ${evidence.commitSha ?? "(none)"}`);
  return {
    evidence,
    run: {
      ci_run_id: process.env.WALKTHROUGH_RUN_ID || null,
      ci_run_url: process.env.WALKTHROUGH_RUN_URL || null,
    },
    // Matches the walkthrough project's outputDir in e2e/playwright.config.ts.
    resolveAsset: makeAssetResolver(path, outDir, {
      budget,
      outputDir: "test-results-walkthrough",
    }),
  };
}

function ingestJourneys(evidenceFile, outDir) {
  let bytes = readEvidenceBytes(evidenceFile);
  let evidence = bytes ? parseEvidence(bytes.toString("utf8")) : { tests: [] };
  if (bytes && !admitEvidence(evidence, "journey evidence")) {
    bytes = null;
    evidence = { tests: [] };
  }
  const provenance = buildRunProvenance(process.env, {
    artifactDigest: bytes ? sha256Hex(bytes) : null,
  });
  const budget = createByteBudget();
  const journeys = buildJourneys({
    evidence,
    manifest: config.journeyManifest,
    product: config.productSlug,
    provenance,
    resolveAsset: makeAssetResolver(evidenceFile, outDir, { budget }),
    walkthrough: loadWalkthrough(outDir, budget),
  });
  const withVideo = journeys.filter((j) => j.video).length;
  console.log(`  ${withVideo}/${journeys.length} journeys play a walkthrough recording`);
  console.log(`  published assets: ${budget.used} / ${budget.limit} bytes`);
  return { journeys, provenance };
}

// Dispatch a config section descriptor to its engine renderer. The "tests" section is
// engine-native (tiles+bars+callouts from metrics); "journeys" renders Journey[];
// "custom" passes product HTML through verbatim.
function renderSections(sectionsCfg, { metrics, pkgs, journeys }) {
  return sectionsCfg
    .map((s) => {
      if (s.kind === "tests") {
        const tiles = `<div class="tiles">\n      ${renderTiles(config.tiles(metrics))}\n    </div>`;
        const sorted = [...pkgs].sort((a, b) => b.pass - a.pass);
        const bars = `<div class="bars">\n      ${renderBars(sorted)}\n    </div>`;
        const callouts = `<div class="callouts">\n      ${renderCallouts(config.callouts(metrics))}\n    </div>`;
        return renderSection({
          title: "Test suite",
          meta: `run live by CI · ${new Date().toISOString().slice(0, 10)}`,
          body: `${tiles}\n    ${bars}\n    ${callouts}`,
        });
      }
      if (s.kind === "journeys") {
        return renderSection({ title: s.title, meta: s.meta, body: renderJourneyList(journeys) });
      }
      return renderSection({ title: s.title, meta: s.meta, body: s.html });
    })
    .join("\n\n  ");
}

/** Every trace.zip under the directory (none when it is absent). */
function traceZipsUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter((rel) => basename(rel) === "trace.zip")
    .map((rel) => join(dir, rel));
}

/**
 * The output scan over the evidence, results.json, every trace.zip of both runs and the
 * rendered page. A hit refuses the build (main's catch removes the partly written
 * output); the error lists file + pattern type + location only (the Actions log is public).
 */
function assertOutputClean(evidenceFile, html) {
  const walkthroughFile = process.env.WALKTHROUGH_EVIDENCE_FILE
    ? resolve(process.env.WALKTHROUGH_EVIDENCE_FILE)
    : null;
  const dirs = [dirname(evidenceFile), walkthroughFile && dirname(walkthroughFile)];
  const findings = scanBuild({
    files: [evidenceFile, join(dirname(evidenceFile), "results.json"), walkthroughFile].filter(
      Boolean,
    ),
    traceZips: [...new Set(dirs.filter(Boolean))].flatMap(traceZipsUnder),
    html: { file: "index.html (rendered)", text: html },
    allowedHost: new URL(config.evidenceBaseUrl).hostname,
  });
  if (findings.length === 0) {
    console.log("verify-dashboard: output scan clean");
    return;
  }
  throw new Error(
    `output scan refused the build — ${findings.length} finding(s) (values not logged):\n${formatFindings(findings)}`,
  );
}

function renderFooterLinks(links) {
  return links
    .map(
      (l) =>
        `<a class="flink" href="${l.href}" target="_blank" rel="noopener"><span class="lbl">${l.label}</span>${l.text}</a>`,
    )
    .join("\n    ");
}

async function main() {
  const outDir = OUT_DIR;
  const evidenceFile = resolve(process.env.EVIDENCE_FILE ?? DEFAULT_EVIDENCE);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  console.log(`verify-dashboard: running ${config.packages.length} test suites for live counts`);
  const tmpDir = mkdtempSync(join(tmpdir(), "verify-dashboard-"));
  const pkgs = collectPackageCounts(REPO_ROOT, tmpDir, config.packages);
  for (const p of pkgs) console.log(`  ${p.label}: ${p.pass} pass / ${p.files} files`);

  // Ingest journeys BEFORE building metrics: the e2e tile is derived from the same
  // ingested evidence the journey cards render from, so the count can never contradict
  // the cards — and the generator needs no browser/Playwright at generate time.
  console.log(`verify-dashboard: ingesting journeys from ${evidenceFile}`);
  const { journeys, provenance } = ingestJourneys(evidenceFile, outDir);

  // The tile figure and the "N verified" log line both come from this one engine
  // result — a single source of truth for "what counts as a verified journey" (null
  // when none are, so the tile degrades to a dash instead of a misleading 0).
  const e2eCount = deriveE2eCount(journeys);
  const verified = e2eCount ?? 0;
  console.log(
    `  ${journeys.length} journeys (${verified} verified) bound to run ${provenance.ci_run_id ?? "(local)"}`,
  );
  console.log(`  e2e tile: ${e2eCount ?? "— (no verified journey)"}`);
  const metrics = buildMetrics(pkgs, e2eCount);

  const sha = commitSha();
  const shortSha = sha ? sha.slice(0, 7) : "unknown";
  // One build timestamp: the page date and the "in progress at build time" pills.
  const builtAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  console.log(
    `verify-dashboard: reading CI status for ${sha ?? "(no commit)"} from GitHub Actions`,
  );
  const pills = await collectCiPills(
    process.env.GITHUB_REPOSITORY,
    process.env.GITHUB_TOKEN,
    config.ciPillSpecs,
    sha,
  );

  const template = readFileSync(join(ENGINE_DIR, "template.html"), "utf8");
  const html = fillTemplate(template, {
    PAGE_TITLE: config.branding.pageTitle,
    PAGE_DESCRIPTION: config.branding.pageDescription,
    EYEBROW: config.branding.eyebrow,
    HEADING: config.branding.heading,
    LEDE: config.branding.lede,
    COMMIT: escapeHtml(shortSha),
    GENERATED_DATE: builtAt.slice(0, 10),
    CI_HEADING: escapeHtml(`CI for ${shortSha}`),
    CI_PILLS: renderCiPills(pills, { builtAt }),
    SECTIONS: renderSections(config.sections, { metrics, pkgs, journeys }),
    FOOTER_LINKS: renderFooterLinks(config.branding.footerLinks),
    FOOTER_NOTE: config.branding.footerNote,
  });
  assertOutputClean(evidenceFile, html);
  writeFileSync(join(outDir, "index.html"), html);
  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`verify-dashboard: wrote ${join(outDir, "index.html")}`);
}

main().catch((err) => {
  console.error(err);
  // A refused (or failed) build leaves no dashboard behind: ingest has already copied
  // the run's media into it.
  rmSync(OUT_DIR, { recursive: true, force: true });
  process.exit(1);
});
