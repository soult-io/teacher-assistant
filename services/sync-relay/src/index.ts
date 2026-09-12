// sync-relay (M2) — SCAFFOLD.
//
// Role: an authenticated, append-only relay of opaque encrypted-update blobs,
// keyed by opaque doc-id. It NEVER decrypts, merges, indexes, or computes — the
// CRDT merge is entirely client-side and commutative, so a dumb authenticated
// relay is sufficient (architecture §1.3). The only server-visible metadata is
// blob sizes, timestamps, and which device pubkey may fetch which opaque stream.
//
// Locked invariants the M2 implementation must hold (delivered by the Phase-0
// M2 spec — NOT implemented here):
//   - never decrypts; stores/serves ciphertext it cannot read
//   - ACL keyed on opaque ids + device public keys
//   - logs/metrics carry ZERO student payload (no initials, goal text, or any
//     PII) — errors reference opaque ids only (FERPA Item-2d)
//   - deploy posture B (D-ARCH-3): reachable over public HTTPS via the Lexington
//     NPM with hardened auth (passkeys/strong auth, rate-limiting). The server
//     still only ever holds ciphertext.

import Fastify from "fastify";

const PORT = Number(process.env.SYNC_RELAY_PORT ?? process.env.PORT ?? 8931);

// Logger is on, but no request/response BODY is ever logged: bodies are
// ciphertext + opaque ids by construction, and we keep it that way as the code
// grows (FERPA Item-2d is the most regression-prone surface — see M14).
const app = Fastify({ logger: true, disableRequestLogging: false });

app.get("/health", async () => ({ status: "ok", service: "sync-relay" }));

// Real relay routes (push/fetch of opaque encrypted updates) land with the M2
// spec. Explicit 501 so the surface is discoverable but inert in the scaffold.
app.post("/sync/:docId", async (_req, reply) => {
  reply.code(501).send({ error: "not_implemented", detail: "sync-relay M2 not yet built" });
});

// Bind 0.0.0.0 so the Lexington NPM can resolve this container by name over the
// shared docker network. Host/public exposure is controlled at the compose +
// NPM layer (loopback host bind + reverse proxy), not in the app.
app
  .listen({ host: "0.0.0.0", port: PORT })
  .then((addr) => app.log.info(`sync-relay listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
