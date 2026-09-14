// The lock screen — the passkey unlock gate (M0-AUTH). The app opens locked;
// the encrypted store is unreadable until a verified passkey authentication
// unlocks the device-held keys. The <h1> title is the app's first paint (and the
// e2e smoke anchor).

export function LockScreen({
  onUnlock,
  busy,
  error,
}: {
  readonly onUnlock: () => void;
  readonly busy: boolean;
  readonly error: string | null;
}) {
  return (
    <div className="lock">
      {/* The lock screen renders as the plain `.phone` (no 1180 shell), so its content is
          capped here in a centered `.lockbody` column — otherwise `.btn.wide` (width:100%)
          stretches edge-to-edge on a wide monitor. The cap never binds on mobile. */}
      <div className="lockbody">
        <span className="mark" aria-hidden="true">
          🔒
        </span>
        <h1>Teacher Assistant</h1>
        <p className="locknote">
          Offline-first IEP goal tracking. Student data is end-to-end encrypted on this device;
          unlock with your passkey to open it.
        </p>
        <button
          type="button"
          className="btn primary wide"
          onClick={onUnlock}
          disabled={busy}
          data-testid="unlock"
        >
          {busy ? "Unlocking…" : "Unlock with passkey"}
        </button>
        <p className="err" role="alert">
          {error ?? ""}
        </p>
      </div>
    </div>
  );
}
