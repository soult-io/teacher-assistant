// First setup (F1) for the journeys (device-enrollment-spec rev 2.5 §4.1; flows §3).
// Since EU-7 the app opens on "Set up this device" until a device is set up, so every
// journey first walks S0–S6 on the local synthetic build (VITE_TA_SYNTHETIC=1), where
// setup writes the synthetic caseload.
//
// TEST HARNESS ONLY — nothing here ships in the app:
//   - a fake WebAuthn authenticator (navigator.credentials, injected per document): it
//     answers with the user-verified flag set and NO PRF output, as Bitwarden does, so the
//     app takes Style W (passkey + passphrase) — Niah's real path;
//   - the four control routes setup calls (redeem, list, grant, recovery-wrap), answered
//     in the page as a fresh deployment's relay would. The data routes are left alone.
// The values typed are synthetic: a made-up setup code and passphrase.

import { expect, type Page } from "@playwright/test";

const SETUP_CODE = "7KQ4-M2XD-9HTB-R0WC-4FNA-Q8VJ-2E";
const PASSPHRASE = "blue7kites";

/** Runs in the page before the app: a UV-verifying authenticator with no PRF (Bitwarden-like). */
function fakeAuthenticator(): void {
  const UP_UV_BE_BS = 0x01 | 0x04 | 0x08 | 0x10;
  const rawId = crypto.getRandomValues(new Uint8Array(16)).buffer;
  const authenticatorData = new Uint8Array(37);
  authenticatorData[32] = UP_UV_BE_BS;
  const credentials = {
    create: () =>
      Promise.resolve({ rawId, getClientExtensionResults: () => ({ prf: { enabled: false } }) }),
    get: () =>
      Promise.resolve({
        rawId,
        response: { authenticatorData: authenticatorData.buffer },
        getClientExtensionResults: () => ({}),
      }),
  };
  Object.defineProperty(navigator, "credentials", { configurable: true, get: () => credentials });
}

/**
 * Runs in the page before the app: a fresh deployment's answers to the four setup control
 * routes (no owner yet). Every other request goes to the network unchanged.
 */
function fakeSetupRelay(): void {
  const answers: Record<string, [number, unknown]> = {
    "/sync/devices/list": [404, { error: "not_found", record_id: "e2e" }],
    "/sync/enroll/redeem": [200, { mode: "first", recovery_wrap: null }],
    "/sync/devices/grant": [200, {}],
    "/sync/devices/recovery-wrap": [200, {}],
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const answer = answers[url.pathname];
    if (answer === undefined) {
      return realFetch(input, init);
    }
    const [status, body] = answer;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

/** Install the harness before the first navigation. */
export async function prepareDeviceSetup(page: Page): Promise<void> {
  await page.addInitScript(fakeAuthenticator);
  await page.addInitScript(fakeSetupRelay);
}

/** Walk F1 (S0 → S6) on the open page and land in the app. */
export async function completeFirstSetup(page: Page): Promise<void> {
  await page.getByTestId("setup-start").click();
  await page.getByTestId("setup-code").fill(SETUP_CODE);
  await page.getByTestId("code-continue").click();
  await page.getByTestId("name-continue").click();
  await page.getByTestId("save-passkey").click();
  await page.getByTestId("passphrase").fill(PASSPHRASE);
  await page.getByTestId("passphrase-again").fill(PASSPHRASE);
  await page.getByTestId("save-passphrase").click();
  const code = (await page.getByTestId("recovery-code").innerText()).split(/\s+/).filter(Boolean);
  expect(code).toHaveLength(8);
  await page.getByTestId("wrote-it-down").click();
  await page.getByTestId("check-group-1").fill(code[6] ?? "");
  await page.getByTestId("check-group-2").fill(code[7] ?? "");
  await page.getByTestId("check-recovery").click();
  await page.getByTestId("setup-done").click();
}
