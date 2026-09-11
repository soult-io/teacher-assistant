# Architecture

The authoritative architecture lives in the teacher-assistant agent repo, not
here (it is maintained alongside the product/design docs):

- `teacher-assistant/architecture/system-architecture.md` — system shape,
  module decomposition (M0–M14), stack, crypto/sync/hosting, repo proposal.
- `teacher-assistant/architecture/DECISIONS.md` — the Product Lead / Neil
  decisions that ground the build:
  - **D-ARCH-1** — key recovery = printed paper recovery code (off-server).
  - **D-ARCH-2** — this app repo + the deploy-stack repo, approved 2026-09-11.
  - **D-ARCH-3** — deploy posture **B: public HTTPS via the Lexington NPM +
    hardened auth** (supersedes the WireGuard-only assumption in
    system-architecture.md — read every "WG-only" there as
    public-HTTPS-with-hardened-auth). Offline-first remains mandatory.

## What this repo builds

Four deployable images plus pure/shared packages (see the root README layout).
The security-relevant shape:

- **sync-relay** never decrypts — it stores/serves opaque ciphertext blobs keyed
  by opaque doc-ids, with an ACL over opaque ids + device public keys.
- **content-api** holds only NON-PII reference data.
- **diff-orchestrator** is the only external-egress point and sends de-identified
  payloads only; it logs no prompt/response bodies.
- **domain-core** and **crypto** are pure/PII-free and client-oriented; the
  student data model is decrypted and computed on the device.
