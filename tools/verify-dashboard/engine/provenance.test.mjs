import { describe, expect, it } from "vitest";
import { buildRunProvenance, sha256Hex } from "./provenance.mjs";

describe("sha256Hex", () => {
  it("matches the known SHA-256 of 'abc'", () => {
    // Independently known: printf 'abc' | sha256sum.
    expect(sha256Hex(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("buildRunProvenance", () => {
  it("binds SOURCE_* run metadata and passes the artifact digest through", () => {
    const p = buildRunProvenance(
      {
        SOURCE_RUN_ID: "123",
        SOURCE_REPOSITORY: "soult-io/teacher-assistant",
        SOURCE_COMMIT_SHA: "abcdef0",
        SOURCE_WORKFLOW: "e2e",
        SOURCE_JOB: "e2e",
        SOURCE_RUN_STARTED: "2026-09-18T18:19:55.833Z",
      },
      { artifactDigest: "cafe1234" },
    );
    expect(p).toEqual({
      ci_run_id: "123",
      ci_run_url: "https://github.com/soult-io/teacher-assistant/actions/runs/123",
      commit_sha: "abcdef0",
      workflow: "e2e",
      job: "e2e",
      generated_at: "2026-09-18T18:19:55.833Z",
      artifact_digest: "cafe1234",
    });
  });

  it("prefers an explicit SOURCE_RUN_URL over the synthesised one", () => {
    const p = buildRunProvenance(
      { SOURCE_RUN_ID: "5", SOURCE_RUN_URL: "https://example/run/5" },
      { artifactDigest: null },
    );
    expect(p.ci_run_url).toBe("https://example/run/5");
  });

  it("degrades to nulls with no source env (a local run)", () => {
    const p = buildRunProvenance({}, {});
    expect(p.ci_run_id).toBeNull();
    expect(p.ci_run_url).toBeNull();
    expect(p.workflow).toBe("e2e");
    expect(typeof p.generated_at).toBe("string");
  });
});
