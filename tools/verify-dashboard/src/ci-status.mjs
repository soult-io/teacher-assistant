// CI status pills, read live from the GitHub Actions REST API — the source of
// truth for "CI on main". Best-effort: if the token or API is unavailable (a
// local run, or a fork PR without permissions), every pill degrades to a
// neutral "status unknown" rather than failing the generator.

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
  // A timed-out run is a red result, not a neutral one; a cancelled/skipped one
  // (routinely produced by concurrency cancel-in-progress) is left neutral.
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

// ci.yml holds two visible jobs — `verify` and the `build-images` matrix — so
// its single run is split into two pills read from the run's jobs.
async function ciYmlPills(repo, token) {
  const run = await latestRun(repo, "ci.yml", token);
  if (!run) {
    return [
      { label: "verify", conclusion: "unknown" },
      { label: "build-images ×4", conclusion: "unknown" },
    ];
  }
  const data = await ghGet(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, token);
  const jobs = data.jobs ?? [];
  const verify = jobs.find((j) => j.name === "verify");
  const images = jobs.filter((j) => j.name.startsWith("build-images"));
  return [
    { label: "verify", conclusion: conclusionOf(verify) },
    { label: "build-images ×4", conclusion: worstOf(images.map(conclusionOf)) },
  ];
}

async function workflowPill(repo, file, label, token) {
  return { label, conclusion: conclusionOf(await latestRun(repo, file, token)) };
}

function fallbackPills() {
  return [
    { label: "verify", conclusion: "unknown" },
    { label: "build-images ×4", conclusion: "unknown" },
    { label: "ferpa-guard", conclusion: "unknown" },
    { label: "CodeQL", conclusion: "unknown" },
    { label: "e2e", conclusion: "unknown" },
  ];
}

/**
 * Build the ordered pill list. `e2eIsSmoke` appends the honest "e2e = smoke
 * only" caveat pill. Never throws — API trouble yields the neutral fallback.
 */
export async function collectCiPills(repo, token, { e2eIsSmoke } = {}) {
  let pills;
  if (!repo) {
    pills = fallbackPills();
  } else {
    try {
      pills = [
        ...(await ciYmlPills(repo, token)),
        await workflowPill(repo, "ferpa-guard.yml", "ferpa-guard", token),
        await workflowPill(repo, "codeql.yml", "CodeQL", token),
        await workflowPill(repo, "e2e.yml", "e2e", token),
      ];
    } catch (err) {
      console.warn(`  ci-status: falling back (${err.message})`);
      pills = fallbackPills();
    }
  }
  if (e2eIsSmoke) pills.push({ label: "e2e = smoke only", conclusion: "in_progress" });
  return pills;
}
