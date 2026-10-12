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

## Sync-relay public surface (device-enrollment spec §5.7)

The relay answers exactly these routes; every other path is the identical 404.
Control routes live under `/sync/` with two or more path segments, so they
never match `/sync/:docId`, and carry identifiers only in signed JSON bodies.

| Route | Since | Notes |
|---|---|---|
| `GET /health` | M2 | liveness |
| `GET /sync/:docId`, `POST /sync/:docId` | M2 | signed; per-scope ACL; unknown and unauthorized docs are the identical 404 |
| `POST /sync/enroll/redeem` | EU-2 (TEACH-58) | signed with `x-ta-scope: control`; body exactly `{code}`; every failure is the identical 401; lockout per trusted client IP and global (5 failures / 15 min → 15 min); more than 20 failures in 24 h invalidate every unused owner code |
| `POST /sync/devices/list` | EU-3 (TEACH-59) | active owner only; body exactly `{}`; returns every device key, role, status and its scope tags, kinds and retired flags (no labels) |
| `POST /sync/devices/grant` | EU-3 (TEACH-59) | active owner only; body exactly `{device, scopes: [{tag, kind}]}` (1–16 scopes); a scope-kind invariant or a revoked/unknown device is 409 `conflict` |
| `POST /sync/devices/revoke` | EU-3 (TEACH-59) | active owner only; body exactly `{device}`; permanent and idempotent; the last active owner is 409 `last_owner` |
| `POST /sync/devices/retire-scope` | EU-3 (TEACH-59) | active owner only; body exactly `{tag}`; the scope becomes read-only; the master scope is 409 `master_scope`; an unknown tag is the identical 404 |
| `POST /sync/devices/recovery-wrap` | EU-3 (TEACH-59) | active owner only; body exactly `{blob}` (base64 alphabet plus `.`); over 4 KiB is 413 |
| `POST /sync/enroll/pairing/open` | EU-4 (TEACH-60) | active owner only; body exactly `{sid}`; at most 3 open sessions per deployment; TTL 10 minutes |
| `POST /sync/enroll/pairing/request-put` | EU-4 (TEACH-60) | any valid key; body exactly `{sid, blob}`; first write wins (a taken, unknown or expired session is the identical 404); the signer is recorded |
| `POST /sync/enroll/pairing/request-get` | EU-4 (TEACH-60) | the opener (an active owner) only; body exactly `{sid}` → `{blob}` |
| `POST /sync/enroll/pairing/grant-put` | EU-4 (TEACH-60) | the opener only; body exactly `{sid, device, role: teacher\|para, scopes, blob}`; `device` must be the request signer (else 409 `conflict`); `teacher` enrolls an owner, `para` a member with period scopes only (a master scope is 409) |
| `POST /sync/enroll/pairing/grant-get` | EU-4 (TEACH-60) | the request signer only; body exactly `{sid}` → `{blob}`, then the session is deleted |

Every owner route is signed with `x-ta-scope: control`. A bad or missing
signature, another scope, an unknown key, a member and a revoked device all get
the identical 404, before the body is read (only the framework's content-type
and 1 MiB size checks, 415/413, come earlier, as on every route). Every body is strict: an unknown
field (a label, a name) is 400, and a scope tag must be a UUID (what
`newScopeTag()` mints), so a label-shaped value is 400 too. Expired pairing sessions and owner codes are
swept at the start of every control route. Revocation is permanent, so a signed
grant replayed after a revoke — even on a restarted relay with an empty nonce
cache — is refused.

The pairing mailbox routes (E1 pairing, spec §4.2) use the same preamble: a bad
or missing signature or another scope is the identical 404, and so is a
non-owner on `open`, `request-get` and `grant-put`. The pairing id (`sid`)
travels only in the signed body; no pairing route has a path parameter, so it
never reaches an access log, and it is never written to the relay log. Both
blobs are AEAD-sealed on the devices under a key the relay never sees, and the
blob alphabet (base64 plus `.`) keeps a bare JSON grant off the wire. A blob
over 4 KiB is 413. Each pairing route allows 30 requests a minute per trusted
client IP (the devices poll `request-get` and `grant-get`). Expired sessions are
also swept at startup, before the port opens.

**Admin plane (never public, never proxied):** the operator CLI issues owner
codes. It runs only by exec into the running relay container, on a terminal:

    docker exec -it <relay container> node dist/admin.js issue-owner-code

It refuses when stdout is not a TTY or is the container's own log, so it can
never run as a compose one-shot service or container command (its output would
land in `docker logs`). It prints the code once to that terminal and stores only
its SHA-256 (24 h expiry, single use). Neither the code nor its hash is logged.

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
