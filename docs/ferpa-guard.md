# FERPA-guard (M14)

The FERPA build conditions are enforced as an always-on mechanical gate, not
per-feature goodwill. The suite lives in `tools/ferpa-guard` and runs as its own
required CI check (`.github/workflows/ferpa-guard.yml`), kept separate from the
main pipeline so a red privacy gate is unmissable.

## Why a dedicated suite

The two most regression-prone FERPA items (architecture §6 R3) are:

1. **Item-2d — sync/log/telemetry/URL leakage.** No initials, goal text, or any
   student payload may appear in a log line, URL, error string, or telemetry
   event. Errors reference opaque ids only.
2. **Item-3a — the structural IC-export guard.** A proposed/baseline goal must be
   *incapable* of reaching the Infinite Campus export path.

Both get standalone assertions here so a regression fails the build.

## What runs today (scaffold)

The harness + primitives exist from day one (`src/checks.ts`) with a first set of
real, passing invariants (`test/ferpa-guard.test.ts`):

- no `String.prototype.localeCompare` in source (deterministic ordering; also
  covered by the biome GritQL plugin — defense in depth);
- `diff-orchestrator` disables request-body logging (de-id egress leaves no body
  in logs);
- `sync-relay` does not import the crypto package (it never decrypts);
- an extensible banned-identity-token scan (the concrete token list grows with
  the data model).

## What lands with the feature specs

- Item-3a export-path guard assertions (M6a/M7/M8).
- No-free-text-on-para-surface static + runtime assertions (M13).
- De-identification scrubber assertions on the differentiation payload (M10).
- Identity-clean sync/log/telemetry fixtures (M1/M2).

The `ferpa-privacy-reviewer` agent owns these invariants and is the release gate.
