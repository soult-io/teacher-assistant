// App shell — SCAFFOLD.
//
// This is the offline-first PWA entry point. The TRACK loop (Phase 1: goal
// tracker, to-score queue, baseline/ARC, para surface), PLAN (Phase 2), and
// differentiation (Phase 3) UIs land per their specs. Nothing here reads or
// renders student data — the local encrypted store + sync client (M1/M3) are
// wired in with the Phase-0 spec.

export function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 640 }}>
      <h1>Teacher Assistant</h1>
      <p>Offline-first PWA scaffold. Feature UIs land per the Phase-0/1 specs.</p>
      <p style={{ color: "#6b7280", fontSize: "0.875rem" }}>
        Student data is client-side end-to-end encrypted (D1); the server stores ciphertext only.
      </p>
    </main>
  );
}
