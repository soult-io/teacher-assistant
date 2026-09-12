// sync-relay (M2) entrypoint. Builds the relay over an in-memory store and binds
// 0.0.0.0 so the Lexington NPM can reach it by container name; host/public
// exposure is controlled at the compose + NPM layer (loopback bind + reverse
// proxy, posture B), never in the app. The server only ever holds ciphertext.
//
// The in-memory store is the Phase-0 backing that proves the protocol; the
// durable Postgres ciphertext-blob store is a deploy-time implementation of the
// same RelayStore interface (see store.ts).

import { buildApp } from "./app.js";
import { sodiumReady } from "./sodium-verify.js";
import { InMemoryRelayStore } from "./store.js";

const PORT = Number(process.env.SYNC_RELAY_PORT ?? process.env.PORT ?? 8931);

async function main(): Promise<void> {
  await sodiumReady();
  const app = buildApp(new InMemoryRelayStore());
  const addr = await app.listen({ host: "0.0.0.0", port: PORT });
  app.log.info(`sync-relay listening on ${addr}`);
}

main().catch((err) => {
  // Identity-clean: the error carries no student payload (the relay never sees any).
  console.error(err);
  process.exit(1);
});
