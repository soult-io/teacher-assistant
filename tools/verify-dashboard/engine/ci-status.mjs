// CI status pills (engine mechanics), read from the GitHub Actions REST API at build
// time and BOUND to one commit: every pill is a run of that exact sha, triggered by a
// push, in this repo — never a later commit's run, never a fork's. Product-agnostic:
// config supplies the pill SPECS (which workflow files, which jobs); this only knows
// how to query, select and normalise.
//
// Two neutral non-verdicts, kept distinct:
//   "no_run"  — the API answered, and no run of that workflow exists for the commit.
//               Never filled in from another commit's run.
//   "unknown" — the API could not be read (error, no repo, no valid sha). Best-effort:
//               API trouble degrades every pill to "unknown" rather than failing the
//               generator. Also used, per pill, when the matched run has no job
//               matching the spec, or GitHub reports a completed item with no
//               conclusion.

const API = "https://api.github.com";
const FULL_SHA = /^[0-9a-f]{40}$/;

export const NO_RUN = "no_run";
export const UNKNOWN = "unknown";

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
  if (item.status !== "completed") return "in_progress";
  // A timed-out run is a red result; a cancelled/skipped one (routine with
  // concurrency cancel-in-progress) is left neutral.
  if (item.conclusion === "timed_out") return "failure";
  return item.conclusion ?? UNKNOWN;
}

/**
 * The worst verdict across a set of matrix jobs decides the shared pill: failure, then
 * still running, then a finished non-verdict (e.g. skipped behind a failed `needs`, or
 * cancelled) passed through as-is — never reported as in progress.
 */
function worstOf(conclusions) {
  if (conclusions.length === 0) return UNKNOWN;
  if (conclusions.includes("failure")) return "failure";
  if (conclusions.includes("in_progress")) return "in_progress";
  if (conclusions.every((c) => c === "success")) return "success";
  return conclusions.find((c) => c !== "success" && c !== UNKNOWN) ?? UNKNOWN;
}

/**
 * Is this run a push-triggered run of exactly `sha` from `repo` itself? The query
 * already filters on head_sha/event/branch; this re-checks client-side so the binding
 * does not depend on the API honouring every filter, and rejects a fork PR whose head
 * branch is also named "main" (its head_repository is the fork).
 */
function isRunOfCommit(run, repo, sha) {
  return (
    run.head_sha === sha &&
    run.event === "push" &&
    run.head_repository?.full_name?.toLowerCase() === repo.toLowerCase()
  );
}

/**
 * The newest matching run of `workflowFile` for `sha`, or null when none exists.
 *
 * Several matches are distinct runs (the list returns one entry per run id, already at
 * its latest attempt — a re-run bumps `run_attempt` on the SAME entry). So the choice
 * among matches is by `created_at` (newest wins; ties by the higher id), not by
 * `run_attempt`, which only orders attempts within one run.
 */
async function runForCommit(repo, workflowFile, sha, token) {
  const data = await ghGet(
    `/repos/${repo}/actions/workflows/${workflowFile}/runs?head_sha=${sha}&event=push&branch=main&per_page=100`,
    token,
  );
  const matches = (data.workflow_runs ?? []).filter((run) => isRunOfCommit(run, repo, sha));
  matches.sort(
    (a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0) || b.id - a.id,
  );
  return matches[0] ?? null;
}

/** Does a job name match a job spec ({equals} exact, or {startsWith} prefix)? */
function jobMatches(job, jobSpec) {
  if (jobSpec.equals) return job.name === jobSpec.equals;
  if (jobSpec.startsWith) return job.name.startsWith(jobSpec.startsWith);
  return false;
}

/** The labels one spec produces, each set to `conclusion`. */
function specPills(spec, conclusion) {
  return spec.jobs
    ? spec.jobs.map((j) => ({ label: j.label, conclusion }))
    : [{ label: spec.label, conclusion }];
}

// A spec with `jobs` splits one run into several pills read from THAT run's jobs
// (e.g. ci.yml's `verify` + the `build-images` matrix). A spec without `jobs` is one
// pill from the run's own conclusion.
async function pillsForSpec(repo, spec, sha, token) {
  const run = await runForCommit(repo, spec.workflow, sha, token);
  if (!run) return specPills(spec, NO_RUN);
  if (!spec.jobs) return [{ label: spec.label, conclusion: conclusionOf(run) }];
  // filter=latest: the jobs of the run's latest attempt, matching the run's status.
  const data = await ghGet(
    `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
    token,
  );
  const jobs = data.jobs ?? [];
  return spec.jobs.map((jobSpec) => ({
    label: jobSpec.label,
    conclusion: worstOf(jobs.filter((j) => jobMatches(j, jobSpec)).map(conclusionOf)),
  }));
}

/** Every label the specs will produce, all set to "unknown" (the degraded fallback). */
function fallbackPills(pillSpecs) {
  return pillSpecs.flatMap((spec) => specPills(spec, UNKNOWN));
}

/**
 * Build the ordered pill list for one commit from config specs. Never throws — API
 * trouble (or no repo / no valid sha to bind to) yields the neutral "unknown"
 * fallback so the board still renders. A workflow with no run for the commit yields
 * "no_run" for its pills; another commit's run is never used.
 * @param {string} repo owner/name
 * @param {string} token
 * @param {{workflow: string, label?: string, jobs?: object[]}[]} pillSpecs
 * @param {string} sha the full 40-hex commit sha the dashboard is built from
 */
export async function collectCiPills(repo, token, pillSpecs, sha) {
  if (!repo) return fallbackPills(pillSpecs);
  if (!FULL_SHA.test(sha ?? "")) {
    console.warn(`  ci-status: falling back (not a full commit sha: ${JSON.stringify(sha)})`);
    return fallbackPills(pillSpecs);
  }
  try {
    const groups = await Promise.all(pillSpecs.map((spec) => pillsForSpec(repo, spec, sha, token)));
    return groups.flat();
  } catch (err) {
    console.warn(`  ci-status: falling back (${err.message})`);
    return fallbackPills(pillSpecs);
  }
}
