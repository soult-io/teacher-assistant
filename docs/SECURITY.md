# Security posture

## Data protection — D1 (client-side E2E encryption)

Student data is encrypted on the device with a two-tier key hierarchy and the
server stores **ciphertext only**:

- **Teacher master key (MK)** — symmetric root, only on the teacher's devices.
- **Period Data-Encryption-Key (Period DEK)** — one per class period; encrypts
  only the para-visible projection of that period. The paraprofessional's device
  holds **only** its period's DEK and is cryptographically incapable of reading
  goal definitions or any other period. Least privilege lives in the key
  hierarchy, not a UI toggle or a server check.

Keys never leave a device unwrapped; the server never receives MK or any DEK
unwrapped. Recovery is a **printed paper recovery code** (D-ARCH-1) — no escrow
share ever lands on the server. Losing all keys and the code = permanent loss;
that is the accepted cost of "the server can never read student data."

## Network posture — B (public HTTPS + hardened auth, D-ARCH-3)

Reachable over public HTTPS via the Lexington NPM (TLS + HSTS terminate there),
protected by hardened authentication: strong auth / passkeys, rate-limiting,
and a minimal exposed surface. This is a **build requirement**, and the public
posture is gated on the FERPA/security review blessing it. TLS protects
transport; D1 protects the data itself.

## FERPA build conditions (M14)

Enforced mechanically by the FERPA-guard suite (`tools/ferpa-guard`, its own
required CI gate) — see `docs/ferpa-guard.md`. Highlights:

- **Identity-clean everything (Item-2d):** initials-only in the app; opaque ids
  in all URLs/logs/telemetry/errors; no student payload in any sync/log line.
- **Structural IC-export guard (Item-3a):** the exporter is *incapable* of
  emitting for a proposed/baseline goal — a code-path guard, not a hidden button.
- **No free-text on the para surface** — a closed, locked observation set only.
- **De-identified LLM egress** — no initials or verbatim goal text ever leave.
- **No plaintext student data at rest** on the server or in the browser HTTP
  cache; the at-rest IndexedDB payload is itself ciphertext.

## Reporting

This is a private, single-teacher tool. Report a security concern to the
maintainers directly; do not open a public issue with sensitive detail.
