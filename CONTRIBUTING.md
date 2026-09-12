# Contributing

Thanks for your interest. This document covers the dev setup, the checks every
PR must pass, and what to expect in review.

## Dev setup

Prereqs: Node ≥ 22, pnpm 11 (`npm install -g pnpm`), Docker (for Postgres, when
the services need it).

```sh
pnpm install
pnpm dev          # runs each workspace's dev script
```

## Checks (all must be green before merge)

```sh
pnpm lint         # biome + the vendored GritQL plugin (localeCompare ban)
pnpm build        # all workspaces, topological
pnpm typecheck
pnpm test         # unit tests (vitest)
pnpm ferpa-guard  # FERPA static-check suite (M14) — a required gate
pnpm e2e          # Playwright (builds first)
```

Run a single workspace while iterating:

```sh
pnpm --filter @teacher-assistant/domain-core test
```

## Privacy is a hard constraint, not a nice-to-have

This app handles student data under a strict privacy model (D1 client-side E2E
encryption; FERPA build conditions in `docs/ferpa-guard.md`). A change that
touches logging, URLs, telemetry, the export path, the para surface, the sync
path, or the differentiation payload must keep the FERPA-guard suite green and
will get extra scrutiny. When in doubt, keep student payload off the server and
out of every log/URL — the server sees ciphertext and opaque ids only.

## Review

PRs are reviewed via the fleet code-pipeline (correctness + quality + qa) and,
for privacy-relevant changes, the FERPA reviewer. No self-merge.
