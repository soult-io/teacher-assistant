# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** through GitHub's private
vulnerability reporting:

**Repository → Security → Advisories → Report a vulnerability**

(<https://github.com/soult-io/teacher-assistant/security/advisories/new>)

Please do **not** open a public issue for a vulnerability. We will acknowledge
your report as quickly as we can and coordinate a fix and disclosure timeline
with you.

## Scope

This is a **self-hosted** application. It is designed around **D1 client-side
end-to-end encryption**: student data is encrypted on the device and the server
stores ciphertext only. In scope:

- Vulnerabilities in the application code in this repository — especially any
  path that could weaken the encryption boundary (a plaintext student payload
  reaching the server, a log, a URL, telemetry, or the browser HTTP cache), the
  key hierarchy / para least-privilege scoping, the structural IC-export guard,
  or the de-identification of the differentiation payload.
- The reference deployment artifacts (`Dockerfile`s, the stack repo's compose)
  where they would lead an operator following the docs into an insecure setup.

Out of scope:

- The maintainers' own QA/production instances — not a target; testing against
  them is not authorized.
- Issues requiring already-authenticated teacher access (the teacher is trusted
  by design), physical/host access, or third-party dependency issues without a
  demonstrated exploit path through this app.

The FERPA build conditions and the guard suite are documented in
`docs/ferpa-guard.md`; the security posture in `docs/SECURITY.md`.

## Supported versions

Only the latest release tag is supported with security fixes. Run a pinned
release (`:vX.Y.Z`), not `:latest`, and follow releases for updates.
