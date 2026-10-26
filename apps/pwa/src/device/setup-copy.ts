// The setup and unlock copy (design/flows-device-enrollment.md §3 errors E-S1..E-S7, §4
// unlock errors; spec §13 A-3, rev 2.7 "text Neil"). One source for every string the
// device layer's errors and the screens both show. No crypto here: jsdom imports it.

export const SETUP_ERRORS = {
  code: "That setup code didn't work. Codes work once and last 24 hours. Check it with Neil, or ask him for a new one.",
  tooMany: "Too many tries. Wait 15 minutes, then try again.",
  connect: "Connect to the internet to finish setup.",
  passkey:
    "Try your passkey again. If Bitwarden doesn't pop up, choose Bitwarden in the window that appears.",
  homeScreen: "Add to Home Screen first, then open the app from the icon.",
  noPasskey:
    "This device can't save a passkey yet. Open Bitwarden and make sure it's unlocked, or turn on a screen lock in your device's Settings. Then come back.",
  stopped: "Setup can't finish on this device — text Neil.",
} as const;

/** The S2 result line on a device whose passkey gives no PRF output (Style W, DN-1a). */
export const STYLE_W_LINE =
  "Your password manager's passkey can't unlock the app by itself yet, so you'll also set a passphrase.";
