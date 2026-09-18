// Orchestrator: assemble the live verification dashboard from a per-product config +
// the engine. Thin on purpose — every product-agnostic mechanic (counts, CI pills,
// journey ingest, rendering) lives in engine/; every product string (suites,
// workflows, journey manifest, branding, page sections) lives in config/. Swap the config
// import and the same engine renders another product.
//
//   engine counts + CI (config-driven)  +  journey-evidence.json (ingest)
//   -> Journey[] + tiles/bars -> engine/template.html -> <outDir>/index.html
//      + videos/*.webm + traces/*.zip
//
// The visual proof of each journey is the run's own video (ingested from the e2e
// artifacts), so there is no separate screenshot capture step: this generator needs
// no browser and no preview server.
//
// Assumes `pnpm -r run build` has run (the workflow does this first).
// Usage: node src/generate.mjs [outDir]   (EVIDENCE_FILE env overrides the evidence path)

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { collectCiPills } from "../engine/ci-status.mjs";
import { collectE2eCount, collectPackageCounts } from "../engine/counts.mjs";
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

// Copy a video/trace out of the ingested artifact tree to a served file next to the
// dashboard, and return its dashboard-relative path. Videos are a few MB — served as
// files, never inlined as data: URIs. Returns null if the source cannot be located.
function makeAssetResolver(evidenceFile, outDir) {
  const artifactRoot = resolve(dirname(evidenceFile));
  const dirs = { video: "videos", trace: "traces" };
  const exts = { video: "webm", trace: "zip" };
  return (rawPath, kind, journeyId, engine) => {
    // The evidence path is the CI-container absolute path; locally it exists as-is,
    // in CI it must be remapped under the downloaded artifact root.
    let src = rawPath;
    if (!existsSync(src)) {
      const marker = "test-results/";
      const idx = rawPath.indexOf(marker);
      src = idx >= 0 ? join(artifactRoot, rawPath.slice(idx + marker.length)) : rawPath;
    }
    // Evidence is untrusted data: confine the copy SOURCE to the artifact tree so a
    // path in the evidence file can never make us serve an out-of-tree file (a `../`
    // escape or an absolute path that happens to exist). The dest is already sanitised.
    const resolvedSrc = resolve(src);
    if (resolvedSrc !== artifactRoot && !resolvedSrc.startsWith(artifactRoot + sep)) {
      console.warn(
        `  asset: ${kind} for ${journeyId}/${engine} resolves outside the artifact tree — skipped`,
      );
      return null;
    }
    const relDir = dirs[kind];
    // Sanitise both parts of the served filename so no id/engine value can escape outDir.
    const safeId = journeyId.replace(/\W/g, "-");
    const safeEngine = engine.replace(/\W/g, "-");
    const rel = `${relDir}/${safeId}-${safeEngine}.${exts[kind]}`;
    try {
      mkdirSync(join(outDir, relDir), { recursive: true });
      copyFileSync(src, join(outDir, rel));
      return rel;
    } catch (err) {
      console.warn(`  asset: could not serve ${kind} for ${journeyId}/${engine}: ${err.message}`);
      return null;
    }
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
  const e2eCount = collectE2eCount(REPO_ROOT, config.e2ePackage);
  for (const p of pkgs) console.log(`  ${p.label}: ${p.pass} pass / ${p.files} files`);
  console.log(`  e2e: ${e2eCount}`);
  const metrics = buildMetrics(pkgs, e2eCount);

  console.log("verify-dashboard: reading CI status from GitHub Actions");
  const pills = await collectCiPills(
    process.env.GITHUB_REPOSITORY,
    process.env.GITHUB_TOKEN,
    config.ciPillSpecs,
  );

  console.log(`verify-dashboard: ingesting journeys from ${evidenceFile}`);
  const { journeys, provenance } = ingestJourneys(evidenceFile, outDir);
  const verified = journeys.filter((j) => j.status !== "unverified").length;
  console.log(
    `  ${journeys.length} journeys (${verified} verified) bound to run ${provenance.ci_run_id ?? "(local)"}`,
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
