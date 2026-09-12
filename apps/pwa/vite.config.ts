import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Offline-first is MANDATORY (architecture §1.2): Niah's device is often
// without connectivity (taking probes home; school networks). The service
// worker precaches ONLY the app shell + build assets. Student-linked data is
// NEVER cached over HTTP — it is served exclusively from the local encrypted
// store (a plaintext response cache of student data would violate D1 / FERPA
// Item-2a). Reference (NON-PII) data caching is added deliberately, per-route,
// when content-api lands.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Precache the app shell only. Do NOT add a runtimeCaching rule that would
      // cache any student-data response.
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,ico,woff2}"],
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
});
