// The real relay in process for node-realm device tests (EU-7 F1, EU-8 pairing): buildApp
// over an InMemoryRelayStore, reached through a Fastify-inject transport that records every
// request the devices sent and can drop or replace answers to test ambiguous outcomes.

import type { RelayHttpRequest, Transport } from "@teacher-assistant/sync";
import { buildApp } from "@teacher-assistant/sync-relay/app";
import { newOwnerCode, ownerCodeHash } from "@teacher-assistant/sync-relay/owner-code";
import { InMemoryRelayStore } from "@teacher-assistant/sync-relay/store";

type RelayApp = ReturnType<typeof buildApp>;

export interface Relay {
  readonly store: InMemoryRelayStore;
  readonly app: RelayApp;
  /** Every request the devices sent: path + parsed body. */
  readonly sent: { readonly path: string; readonly body: string }[];
  transport(options?: {
    readonly dropResponse?: (path: string) => boolean;
    /** Answer this path with a fixed status instead of the relay (nothing reaches it). */
    readonly answer?: (path: string) => number | undefined;
    /** Runs after the relay handled the request, before the answer returns. */
    readonly after?: (path: string) => void;
  }): Transport;
  issueCode(): Promise<string>;
}

export function relay(): Relay {
  const store = new InMemoryRelayStore();
  const app = buildApp(store, { logStream: { write: () => {} } });
  const sent: { path: string; body: string }[] = [];
  return {
    store,
    app,
    sent,
    transport:
      (options = {}) =>
      async (req: RelayHttpRequest) => {
        const body = new TextDecoder().decode(req.body);
        sent.push({ path: req.path, body });
        const fixed = options.answer?.(req.path);
        if (fixed !== undefined) {
          const json = new TextEncoder().encode(JSON.stringify({ error: "x", record_id: "r" }));
          return { status: fixed, body: json };
        }
        const res = await app.inject({
          method: req.method,
          url: req.path,
          headers: req.headers,
          ...(req.method === "GET" ? {} : { payload: body }),
        });
        options.after?.(req.path);
        if (options.dropResponse?.(req.path) === true) {
          throw new TypeError("Failed to fetch"); // committed on the relay, no answer here
        }
        return { status: res.statusCode, body: new Uint8Array(res.rawPayload) };
      },
    issueCode: async () => {
      const code = newOwnerCode();
      const hash = ownerCodeHash(code);
      if (hash === undefined) {
        throw new Error("bad code");
      }
      await store.issueOwnerCode(hash, new Date(Date.now() + 60 * 60_000));
      return code;
    },
  };
}
