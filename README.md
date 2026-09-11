# Teacher Assistant

Offline-first PWA that helps an 8th-grade Kentucky LBD (Learning & Behavior
Disorders) special-education teacher plan lessons and track IEP goal progress,
with a least-privilege paraprofessional surface and de-identified lesson
differentiation.

> **Status: scaffold.** This repo currently holds the monorepo skeleton, tooling,
> CI, and the FERPA-guard harness — no student-data feature code yet. Phase-0
> module code (crypto/sync) and Phase-1 TRACK features arrive per their specs.

## Architecture at a glance

- **D1 — client-side end-to-end encryption.** Student data is encrypted on the
  device; the server (and its Postgres and backups) store **ciphertext only** and
  can never read it. Merge/compute is client-side; the server is a dumb
  authenticated relay. Keys live on the device.
- **Deploy posture B — public HTTPS + hardened auth** (decision D-ARCH-3). The
  app is reachable over **public HTTPS via the Lexington NPM** (TLS terminates
  there) with hardened authentication (strong auth / passkeys, rate-limiting,
  minimal exposed surface). This supersedes the earlier "WireGuard-only"
  assumption. TLS is transport encryption; the D1 encryption is what protects the
  data at rest — endpoint reach yields ciphertext, not readable data.
- **Offline-first is mandatory** (not merely enabled by the network posture).
  Scoring must work for days with zero connectivity — probes are often scored at
  home or where the network is unavailable — and reconcile conflict-free when a
  network returns (Yjs CRDT + encrypted-update relay).
- **De-identified differentiation.** The only external egress (an LLM) receives
  de-identified prompts only — no initials, no verbatim goal text.

Full architecture: `docs/ARCHITECTURE.md` (a pointer to the authoritative
`system-architecture.md` + `DECISIONS.md`). Security posture: `docs/SECURITY.md`.
FERPA build conditions + the guard suite: `docs/ferpa-guard.md`.

## Monorepo layout (pnpm workspaces)

```
apps/pwa/                  React + Vite + vite-plugin-pwa — offline-first client
services/sync-relay/       encrypted opaque-blob relay (never decrypts)
services/content-api/      NON-PII reference API (curriculum/standards/calendar)
services/diff-orchestrator/ de-identified LLM orchestration (logs no bodies)
packages/domain-core/      pure, PII-free logic (weeks/grading/trend) — unit-tested
packages/crypto/           M0 keyring/AEAD/wrapping/enrollment/recovery
packages/schema/           shared types — CO-OWNED with data-model-integration
tools/ferpa-guard/         FERPA static-check suite (M14) — its own required CI gate
e2e/                       Playwright browser E2E
```

## Module map (M0–M14)

| Module | What | Phase |
|---|---|---|
| **M0** | Crypto / identity / keyring core (MK + per-period DEKs, AEAD, wrapping, QR enrollment, paper recovery, para-scoped keys + rotation) | 0 |
| **M1** | Sync client — encrypted CRDT engine (Yjs, offline queue, reconnect reconciliation, encrypted IndexedDB) | 0 |
| **M2** | sync-relay server — authenticated append-only encrypted-update store, per-opaque-id ACL, never decrypts | 0 |
| **M3** | Local store / repository + projections (owes-by-week, to-score queue, baseline view) | 0 |
| **M4** | Instructional-weeks primitive + calendar (shared, pure) | 0 |
| **M5** | Goal-tracker + progress monitoring (weekly data points, no-data ≠ 0, consistency window, baseline gate) | 1 |
| **M6** | Dual grading engines + export — M6a IEP % → Infinite Campus, M6b MYP → Toddle (never coerced) | 1 / 4 |
| **M7** | Baseline / proposed-goal track + ARC/IEP dates | 1 |
| **M8** | Auto progress-statement + trend engine (structured slots only) | 1 |
| **M9** | Weekly PLAN — intra-day block model + two class formats | 2 |
| **M10** | Differentiation engine (LLM, de-identified) | 3 |
| **M11** | content-api + diff-orchestrator (NON-PII server) | 0 / 3 |
| **M13** | Para role surface (period-scoped, observation chips, no free-text) | 1 |
| **M14** | Privacy / identity / crypto discipline (cross-cutting) + the FERPA-guard CI suite | 0 → all |

Build order: **Phase 0** (foundation: M0–M4, M11, M14 + this skeleton) →
**Phase 1** (TRACK loop: M5, M7, M6a, M8, M13) → Phase 2 (PLAN) →
Phase 3 (differentiation) → Phase 4 (MYP).

## Develop

```bash
pnpm install
pnpm lint         # biome + vendored GritQL plugin (localeCompare ban)
pnpm build        # all workspaces (topological)
pnpm typecheck
pnpm test         # unit tests
pnpm ferpa-guard  # FERPA static checks (M14)
pnpm e2e          # Playwright (builds first)
```

## Deploy

Images publish to GHCR (`ghcr.io/soult-io/teacher-assistant-{pwa,sync-relay,content-api,diff-orchestrator}`).
Deployment is GitOps via the **Lexington** Portainer, driven by the deploy-stack
repo `nsoult-agentic/stack-lexington-teacher-assistant` — not from this repo.
The code owner merges PRs here; infra runs the deploy. No self-merge.
