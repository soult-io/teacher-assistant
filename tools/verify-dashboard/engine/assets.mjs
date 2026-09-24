// Asset serving: copy a run artifact (video, trace, per-step still) out of the ingested
// artifact tree to a file next to the dashboard, and return its dashboard-relative path.
// Assets are served as files, never inlined as data: URIs. Product-agnostic: it knows
// kinds of evidence, not what a journey is about.

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";

/**
 * Size cap for one still. The e2e capture already bounds resolution + JPEG quality
 * (a still is tens of KB); a file over this cap means that contract broke, so the
 * generator fails loud rather than serving it or quietly dropping it.
 */
export const MAX_STILL_BYTES = 2 * 1024 * 1024;

// A still's extension must match its leading bytes (the artifact is untrusted data).
// `ext` is the served extension.
const STILL_FORMATS = {
  ".jpg": { magic: [0xff, 0xd8, 0xff], ext: "jpg" },
  ".jpeg": { magic: [0xff, 0xd8, 0xff], ext: "jpg" },
  ".png": { magic: [0x89, 0x50, 0x4e, 0x47], ext: "png" },
};

function hasMagic(src, magic) {
  const head = Buffer.alloc(magic.length);
  const fd = openSync(src, "r");
  try {
    readSync(fd, head, 0, magic.length, 0);
  } finally {
    closeSync(fd);
  }
  return magic.every((byte, i) => head[i] === byte);
}

const KINDS = {
  video: { dir: "videos", ext: () => "webm" },
  trace: { dir: "traces", ext: () => "zip" },
  still: { dir: "stills", ext: (src) => STILL_FORMATS[extname(src).toLowerCase()].ext },
};

/** The served name: `<id>-<engine>` (+ `-<NN>` step index for a still), sanitised. */
function servedName(kind, journeyId, engine, index) {
  const safeId = journeyId.replace(/\W/g, "-");
  const safeEngine = engine.replace(/\W/g, "-");
  if (kind !== "still") return `${safeId}-${safeEngine}`;
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`still for ${journeyId}/${engine} needs a step index, got ${index}`);
  }
  return `${safeId}-${safeEngine}-${String(index).padStart(2, "0")}`;
}

/** A still must be a jpeg/png within the byte cap — otherwise the run broke its contract. */
function assertStillServable(src, journeyId, engine, index) {
  const where = `still for ${journeyId}/${engine} step ${index}`;
  const format = STILL_FORMATS[extname(src).toLowerCase()];
  if (!format || !hasMagic(src, format.magic)) {
    throw new Error(`${where} is not a jpeg/png image: ${src}`);
  }
  const bytes = statSync(src).size;
  if (bytes > MAX_STILL_BYTES) {
    throw new Error(`${where} is ${bytes} bytes — exceeds the ${MAX_STILL_BYTES} byte cap`);
  }
}

/**
 * Map an evidence path to a file under the artifact root, or null if it escapes it.
 * The evidence path is the CI-container absolute path; locally it exists as-is, in CI
 * it must be remapped under the downloaded artifact root.
 */
function locateSource(rawPath, artifactRoot) {
  let src = rawPath;
  if (!existsSync(src)) {
    const marker = "test-results/";
    const idx = rawPath.indexOf(marker);
    src = idx >= 0 ? join(artifactRoot, rawPath.slice(idx + marker.length)) : rawPath;
  }
  // Evidence is untrusted data: confine the copy SOURCE to the artifact tree so a path
  // in the evidence file can never make us serve an out-of-tree file (a `../` escape
  // or an absolute path that happens to exist). The dest name is sanitised separately.
  const resolvedSrc = resolve(src);
  const inside = resolvedSrc === artifactRoot || resolvedSrc.startsWith(artifactRoot + sep);
  return inside ? resolvedSrc : null;
}

/**
 * @param {string} evidenceFile the journey-evidence.json path; its directory is the artifact root
 * @param {string} outDir the dashboard output directory
 * @returns {(rawPath: string, kind: "video"|"trace"|"still", journeyId: string,
 *   engine: string, index?: number) => (string|null)} null = the asset could not be
 *   located or served (the caller renders it absent)
 */
export function makeAssetResolver(evidenceFile, outDir) {
  const artifactRoot = resolve(dirname(evidenceFile));
  return (rawPath, kind, journeyId, engine, index) => {
    const spec = KINDS[kind];
    if (!spec) throw new Error(`unknown asset kind ${JSON.stringify(kind)}`);
    const name = servedName(kind, journeyId, engine, index);
    const resolvedSrc = locateSource(rawPath, artifactRoot);
    if (!resolvedSrc) {
      console.warn(
        `  asset: ${kind} for ${journeyId}/${engine} resolves outside the artifact tree — skipped`,
      );
      return null;
    }
    if (!existsSync(resolvedSrc)) {
      console.warn(`  asset: ${kind} for ${journeyId}/${engine} is missing from the artifact`);
      return null;
    }
    if (kind === "still") assertStillServable(resolvedSrc, journeyId, engine, index);
    const rel = `${spec.dir}/${name}.${spec.ext(resolvedSrc)}`;
    try {
      mkdirSync(join(outDir, spec.dir), { recursive: true });
      copyFileSync(resolvedSrc, join(outDir, rel));
      return rel;
    } catch (err) {
      console.warn(`  asset: could not serve ${kind} for ${journeyId}/${engine}: ${err.message}`);
      return null;
    }
  };
}
