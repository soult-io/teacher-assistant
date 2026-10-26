import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// TEACH-74: the synthetic caseload ships ONLY in a QA/synthetic build (VITE_TA_SYNTHETIC=1,
// the ta-qa image). Every other build (the prod image, a release) replaces the seed
// module with a stub, so the seed's records are not in the bundle at all. The flag alone
// is not enough: first setup takes `synthetic` as a runtime argument, so the bundler
// cannot drop the seed as dead code. CI checks the built image (tools/synthetic-seed-check.sh).
const PWA_ROOT = fileURLToPath(new URL(".", import.meta.url));
const SYNTHETIC_SEED = fileURLToPath(new URL("./src/data/synthetic-seed.ts", import.meta.url));

function stubSyntheticSeed(): Plugin {
  return {
    name: "ta-stub-synthetic-seed",
    apply: "build",
    enforce: "pre",
    load(id) {
      if (id.split("?")[0] !== SYNTHETIC_SEED) {
        return null;
      }
      return 'export function buildSyntheticSeed() { throw new Error("This build has no synthetic data."); }';
    },
  };
}

// Offline-first is MANDATORY (architecture §1.2): Niah's device is often without
// connectivity (taking probes home; school networks). The service worker precaches
// ONLY the app shell + hashed build assets. Student-linked data is NEVER cached over
// HTTP — it is served exclusively from the local encrypted store (a plaintext
// response cache of student data would violate D1 / FERPA Item-2a). Reference
// (NON-PII) data caching is added deliberately, per-route, when content-api lands.
//
// injectManifest (hand-written src/sw.ts) rather than generateSW: the shell update
// path (H-PUB-2) needs a navigation route that is NetworkFirst when ONLINE but falls
// back to the PRECACHE when OFFLINE — a deploy must reach a returning visitor on a
// normal reload without losing offline-first. generateSW's declarative navigation
// options cannot express "network-first online, durable-precache fallback offline",
// and the hand-written SW also makes the exact cache boundary auditable for FERPA.
export default defineConfig(({ mode }) => ({
  plugins: [
    ...(loadEnv(mode, PWA_ROOT, "VITE_").VITE_TA_SYNTHETIC === "1" ? [] : [stubSyntheticSeed()]),
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // The new SW takes over promptly (skipWaiting/clientsClaim in sw.ts) and the
      // registration reloads the page when it does. Inline the registration into
      // index.html (no separate registerSW.js) so it rides index.html's no-cache and
      // can never itself be served stale.
      registerType: "autoUpdate",
      injectRegister: "inline",
      // Precache the app shell only. Do NOT add anything here that would cache a
      // student-data response.
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,ico,woff2}"],
      },
      devOptions: {
        // Keep `vite dev` free of the service worker; SW behaviour is exercised
        // against the built shell (`vite preview`) and in e2e.
        enabled: false,
      },
      manifest: {
        name: "Teacher Assistant",
        short_name: "TeachAsst",
        description: "Offline-first planning + IEP goal tracking",
        theme_color: "#1f2937",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // Dev-only: forward to the local services (see .env.example ports).
      "/sync": "http://localhost:8931",
      "/reference": "http://localhost:8932",
      "/differentiate": "http://localhost:8933",
    },
  },
  build: {
    outDir: "dist",
  },
}));
