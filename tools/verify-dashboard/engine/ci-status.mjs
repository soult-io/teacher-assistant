// CI status pills (engine mechanics), read live from the GitHub Actions REST API —
// the source of truth for "CI on main". Product-agnostic: config supplies the pill
// SPECS (which workflow files, which jobs); this only knows how to query and
// normalise. Best-effort: any API trouble degrades every pill to a neutral "unknown"
// rather than failing the generator.

const API = "https://api.github.com";

function apiHeaders(token) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "verify-dashboard",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function ghGet(path, token) {
  const res = await fetch(`${API}${path}`, { headers: apiHeaders(token) });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
  return res.json();
}

/** Normalise a run/job to pass/fail/pending: an incomplete one is not yet a verdict. */
function conclusionOf(item) {
  if (!item) return "unknown";
  if (item.status !== "completed") return "in_progress";
  // A timed-out run is a red result; a cancelled/skipped one (routine with
  // concurrency cancel-in-progress) is left neutral.
  if (item.conclusion === "timed_out") return "failure";
  return item.conclusion ?? "unknown";
}

/** The worst verdict across a set of matrix jobs decides the shared pill. */
function worstOf(conclusions) {
  if (conclusions.length === 0) return "unknown";
  if (conclusions.some((c) => c !== "success" && c !== "unknown")) {
    return conclusions.some((c) => c === "failure") ? "failure" : "in_progress";
  }
  return conclusions.every((c) => c === "success") ? "success" : "unknown";
}

async function latestRun(repo, workflowFile, token) {
  const data = await ghGet(
    `/repos/${repo}/actions/workflows/${workflowFile}/runs?branch=main&per_page=1`,
    token,
  );
  return data.workflow_runs?.[0] ?? null;
}

/** Does a job name match a job spec ({equals} exact, or {startsWith} prefix)? */
function jobMatches(job, jobSpec) {
  if (jobSpec.equals) return job.name === jobSpec.equals;
  if (jobSpec.startsWith) return job.name.startsWith(jobSpec.startsWith);
  return false;
}

// A spec with `jobs` splits one run into several pills read from the run's jobs
// (e.g. ci.yml's `verify` + the `build-images` matrix). A spec without `jobs` is one
// pill from the run's own conclusion.
async function pillsForSpec(repo, spec, token) {
  const run = await latestRun(repo, spec.workflow, token);
  if (!spec.jobs) {
    return [{ label: spec.label, conclusion: conclusionOf(run) }];
  }
  if (!run) return spec.jobs.map((j) => ({ label: j.label, conclusion: "unknown" }));
  const data = await ghGet(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, token);
  const jobs = data.jobs ?? [];
  return spec.jobs.map((jobSpec) => ({
    label: jobSpec.label,
    conclusion: worstOf(jobs.filter((j) => jobMatches(j, jobSpec)).map(conclusionOf)),
  }));
}

/** Every label the specs will produce, all set to "unknown" (the degraded fallback). */
function fallbackPills(pillSpecs) {
  return pillSpecs.flatMap((spec) =>
    spec.jobs
      ? spec.jobs.map((j) => ({ label: j.label, conclusion: "unknown" }))
      : [{ label: spec.label, conclusion: "unknown" }],
  );
}

/**
 * Build the ordered pill list from config specs. Never throws — API trouble yields
 * the neutral fallback so the board still renders.
 * @param {string} repo owner/name
 * @param {string} token
 * @param {{workflow: string, label?: string, jobs?: object[]}[]} pillSpecs
 */
export async function collectCiPills(repo, token, pillSpecs) {
  if (!repo) return fallbackPills(pillSpecs);
  try {
    const groups = await Promise.all(pillSpecs.map((spec) => pillsForSpec(repo, spec, token)));
    return groups.flat();
  } catch (err) {
    console.warn(`  ci-status: falling back (${err.message})`);
    return fallbackPills(pillSpecs);
  }
}
