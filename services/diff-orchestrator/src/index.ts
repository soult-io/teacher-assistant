// diff-orchestrator (M11) — SCAFFOLD.
//
// Role: receive DE-IDENTIFIED differentiation prompts (gen-ed lesson + full KY
// standard + abstract support requirements — NO initials, NO verbatim goal
// text), call the external LLM, return the scaffolded lesson. The student
// binding happens client-side AFTER the response returns. This is the ONLY
// component that egresses to an external API, and it does so on PII-free
// payloads only (architecture §1.5, M10/M11).
//
// Locked invariants (delivered by the M10/M11 spec — NOT implemented here):
//   - logs NOTHING of prompt/response bodies
//   - rejects any payload that carries identity (initials / goal text) as
//     defense in depth, even though the client de-identifies first
//   - the external LLM only ever receives de-identified content

import Fastify from "fastify";

const PORT = Number(process.env.DIFF_ORCHESTRATOR_PORT ?? process.env.PORT ?? 8933);

// disableRequestLogging: request/response bodies must never reach a log line
// here — the de-identified prompt and the returned scaffold are both kept out
// of logs by construction (M14 FERPA build condition).
const app = Fastify({ logger: true, disableRequestLogging: true });

app.get("/health", async () => ({ status: "ok", service: "diff-orchestrator" }));

// Real orchestration endpoint lands with the M10/M11 spec. It will run the
// de-identification guard (reject-on-initials) before any external egress.
app.post("/differentiate", async (_req, reply) => {
  reply
    .code(501)
    .send({ error: "not_implemented", detail: "diff-orchestrator M10/M11 not yet built" });
});

app
  .listen({ host: "0.0.0.0", port: PORT })
  .then((addr) => app.log.info(`diff-orchestrator listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
