// Provenance binding: every verified journey is stamped with the CI run whose
// artifacts produced it, so a card can never claim more than a specific run proved.
// Product-agnostic — reads only generic CI env, hashes bytes it is handed.

import { createHash } from "node:crypto";

/** sha256 of the evidence bytes — the artifact digest on every provenance bar. */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build the run provenance from environment. `SOURCE_*` describe the e2e run whose
 * artifacts were ingested (the CI wiring sets them after resolving the latest main
 * run); `GITHUB_*` are the generating run, used only to synthesise a run URL.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{artifactDigest?: string|null}} [opts]
 */
export function buildRunProvenance(env = process.env, { artifactDigest = null } = {}) {
  const runId = env.SOURCE_RUN_ID || null;
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  const repo = env.SOURCE_REPOSITORY || env.GITHUB_REPOSITORY || null;
  const runUrl =
    env.SOURCE_RUN_URL || (runId && repo ? `${server}/${repo}/actions/runs/${runId}` : null);
  return {
    ci_run_id: runId,
    ci_run_url: runUrl,
    commit_sha: env.SOURCE_COMMIT_SHA || null,
    workflow: env.SOURCE_WORKFLOW || "e2e",
    job: env.SOURCE_JOB || "e2e",
    generated_at: env.SOURCE_RUN_STARTED || new Date().toISOString(),
    artifact_digest: artifactDigest,
  };
}
