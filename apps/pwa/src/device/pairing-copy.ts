// The pairing copy (design/flows-device-enrollment.md §5 Flow 3 and its error table; spec
// rev 2.7 §4.2, §13 A-4). One source for the strings the pairing layer and the screens
// both use. No crypto here: jsdom imports it.

export const PAIRING_COPY = {
  /** Phone side: the slot was taken, expired or unknown; or the laptop stopped. */
  interruptedNew: "Pairing interrupted — start again on your other device.",
  /** Laptop side: the phone's check-in was tampered with, garbled, or carried a wrong name. */
  interrupted: "Pairing interrupted. Start again.",
  timeUp: "Time ran out. Start again.",
  stopped: "Those codes don't match. Pairing stopped for safety. Start again.",
  needsInternet: "Adding a device needs the internet. Connect, then start again.",
  offlineAdd: "Adding a device needs the internet. Connect and try again.",
  tooMany: "Too many devices waiting. Wait 10 minutes, then try again.",
  camera:
    "Camera is off for this app. Tap 'Type the code instead', or allow the camera in Settings.",
  badSquareCode: "That code isn't right. Check it on your other device and type it again.",
  passkeyNew:
    "Try your passkey again. If your password manager doesn't pop up, choose it in the window that appears.",
  busy: "This device is being set up in another window. Finish there, or close that window and open the app again.",
  homeScreen:
    "Using the app from your Home Screen? Add it there first, then open it from the icon.",
} as const;

/** Tries 1–2 of the matching code (flows Flow 3 errors), naming the device being added. */
export function wrongMatchingCode(deviceWord: string): string {
  return `That code doesn't match your ${deviceWord}. Check your ${deviceWord} and type it again.`;
}
