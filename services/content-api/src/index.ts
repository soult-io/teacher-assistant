// content-api (M11) — SCAFFOLD.
//
// Role: serve NON-PII reference data only — curriculum backbone, segment
// catalog, KY standards, MYP rubric reference, calendar/non-instructional
// flags, differentiation template library. No student PII exists here, so
// nothing to encrypt; responses are offline-cacheable by the PWA service worker
// (unlike student data, which is served only from the local encrypted store).
//
// Locked invariants (delivered by the M11 spec — NOT implemented here):
//   - no PII stored or logged, ever
//   - reference data is offline-cacheable

import Fastify from "fastify";

const PORT = Number(process.env.CONTENT_API_PORT ?? process.env.PORT ?? 8932);

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok", service: "content-api" }));

// Real reference endpoints land with the M11 spec.
app.get("/reference/:collection", async (_req, reply) => {
  reply.code(501).send({ error: "not_implemented", detail: "content-api M11 not yet built" });
});

app
  .listen({ host: "0.0.0.0", port: PORT })
  .then((addr) => app.log.info(`content-api listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
