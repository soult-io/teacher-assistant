// Orchestrator: assemble the live verification dashboard from a per-product config +
// the engine. Thin on purpose — every product-agnostic mechanic (counts, CI pills,
// journey ingest, rendering) lives in engine/; every product string (suites,
// workflows, journey manifest, branding, page sections) lives in config/. Swap the config
// import and the same engine renders another product.
//
//   engine counts + CI (config-driven)  +  journey-evidence.json (ingest)
//   -> Journey[] + tiles/bars -> engine/template.html -> <outDir>/index.html
//      + videos/*.webm + traces/*.zip + stills/*.jpg (one per journey step)
//
// The visual proof of each journey is the run's own video + per-step stills (both
// ingested from the e2e artifacts — the stills are taken by the e2e run itself), so
// there is no separate screenshot capture step: this generator needs no browser and
// no preview server.
//
// Assumes `pnpm -r run build` has run (the workflow does this first).
// Usage: node src/generate.mjs [outDir]   (EVIDENCE_FILE env overrides the evidence path)

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeAssetResolver } from "../engine/assets.mjs";
import { collectCiPills } from "../engine/ci-status.mjs";
import { collectPackageCounts, deriveE2eCount } from "../engine/counts.mjs";
import { buildJourneys, parseEvidence } from "../engine/ingest.mjs";
import { buildRunProvenance, sha256Hex } from "../engine/provenance.mjs";
import {
  aggregate,
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

const passOf = (pkgs, name) => pkgs.find((p) => p.name === name)?.pass ?? 0;

function shortSha() {
  const sha = process.env.GITHUB_SHA;
  if (sha) return sha.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT })
      .toString()
      .trim();
  } catch {
    return "unknown";
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
function readEvidenceBytes(evidenceFile) {
  try {
    return readFileSync(evidenceFile);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.warn(`  no evidence at ${evidenceFile} — every journey renders UNVERIFIED`);
      return null;
    }
    throw err;
  }
}

function ingestJourneys(evidenceFile, outDir) {
  const bytes = readEvidenceBytes(evidenceFile);
  const evidence = bytes ? parseEvidence(bytes.toString("utf8")) : { tests: [] };
  const provenance = buildRunProvenance(process.env, {
    artifactDigest: bytes ? sha256Hex(bytes) : null,
  });
  const journeys = buildJourneys({
    evidence,
    manifest: config.journeyManifest,
    product: config.productSlug,
    provenance,
    resolveAsset: makeAssetResolver(evidenceFile, outDir),
  });
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

function renderFooterLinks(links) {
  return links
    .map(
      (l) =>
        `<a class="flink" href="${l.href}" target="_blank" rel="noopener"><span class="lbl">${l.label}</span>${l.text}</a>`,
    )
    .join("\n    ");
}

async function main() {
  const outDir = resolve(process.argv[2] ?? join(REPO_ROOT, "dist-dashboard"));
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

  console.log("verify-dashboard: reading CI status from GitHub Actions");
  const pills = await collectCiPills(
    process.env.GITHUB_REPOSITORY,
    process.env.GITHUB_TOKEN,
    config.ciPillSpecs,
  );

  const template = readFileSync(join(ENGINE_DIR, "template.html"), "utf8");
  const html = fillTemplate(template, {
    PAGE_TITLE: config.branding.pageTitle,
    PAGE_DESCRIPTION: config.branding.pageDescription,
    EYEBROW: config.branding.eyebrow,
    HEADING: config.branding.heading,
    LEDE: config.branding.lede,
    COMMIT: shortSha(),
    GENERATED_DATE: new Date().toISOString().slice(0, 10),
    CI_PILLS: renderCiPills(pills),
    SECTIONS: renderSections(config.sections, { metrics, pkgs, journeys }),
    FOOTER_LINKS: renderFooterLinks(config.branding.footerLinks),
    FOOTER_NOTE: config.branding.footerNote,
  });
  writeFileSync(join(outDir, "index.html"), html);
  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`verify-dashboard: wrote ${join(outDir, "index.html")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
