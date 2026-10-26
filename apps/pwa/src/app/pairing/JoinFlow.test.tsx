// EU-8 (TEACH-75) — the new device's pairing screens B1–B4 (flows §5 Flow 3 phone side;
// spec rev 2.7 §4.2 steps 2 and 5, §11 EU-8, §13 A-5, A-13). A crypto-free JoinPort stands
// in for the pairing layer (tested in process in device/pairing.test.ts).

import type { VaultTier } from "@teacher-assistant/crypto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeviceHandle, JoinPort } from "../../device/device-port.js";
import type { JoinPollOutcome, PostOutcome } from "../../device/pairing.js";
import { DEVICE_LABELS, type DeviceLabel } from "../../device/passkey-prf.js";
import { JoinFlow } from "./JoinFlow.js";

const MATCHING = "3f9a-0c71-be24-d58e";

interface FakeJoin extends JoinPort {
  readonly calls: string[];
  /** Whether the matching code was on screen when postRequest() ran. */
  codeShownAtPost: boolean | null;
}

function fakeJoin(
  options: {
    readonly tier?: VaultTier;
    readonly begin?: boolean;
    readonly post?: PostOutcome;
    readonly poll?: JoinPollOutcome;
    readonly createError?: Error;
  } = {},
): FakeJoin {
  const device: DeviceHandle = { locked: false, lock: () => {} };
  let label: DeviceLabel | undefined;
  const port: FakeJoin = {
    calls: [],
    codeShownAtPost: null,
    begin: (code) => {
      port.calls.push(`begin:${code}`);
      return options.begin ?? true;
    },
    get label() {
      return label;
    },
    setLabel: (l) => {
      label = l;
      port.calls.push(`label:${l}`);
    },
    createPasskey: () => {
      port.calls.push("createPasskey");
      return options.createError === undefined
        ? Promise.resolve(options.tier ?? "prf")
        : Promise.reject(options.createError);
    },
    sealVault: (passphrase) => {
      port.calls.push(`seal:${passphrase ?? ""}`);
      return Promise.resolve({ persisted: true, code: MATCHING });
    },
    postRequest: () => {
      port.codeShownAtPost = screen.queryByTestId("join-matching-code") !== null;
      port.calls.push("post");
      return Promise.resolve(options.post ?? "waiting");
    },
    poll: () => {
      port.calls.push("poll");
      return Promise.resolve(options.poll ?? "done");
    },
    discard: () => {
      port.calls.push("discard");
      return Promise.resolve();
    },
    device,
  };
  return port;
}

// A stand-in scanner: a button that "decodes" a poster QR and records what the flow answered.
const scanResults: boolean[] = [];
const scanningCamera = { getUserMedia: () => new Promise<MediaStream>(() => {}) };
vi.mock("./QrScanner.js", () => ({
  QrScanner: ({
    onResult,
    onBlocked,
    mediaDevices,
  }: {
    readonly onResult: (text: string) => boolean;
    readonly onBlocked: () => void;
    readonly mediaDevices?: unknown;
  }) => {
    if (mediaDevices !== scanningCamera) {
      queueMicrotask(onBlocked); // every other test: no camera
      return null;
    }
    return (
      <button
        type="button"
        data-testid="fake-scan"
        onClick={() => scanResults.push(onResult("https://example.test/poster"))}
      >
        scan
      </button>
    );
  },
}));

const blockedCamera = {
  getUserMedia: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
};

function renderJoin(port: JoinPort) {
  const onDone = vi.fn();
  const onVaultSealed = vi.fn();
  const onLeave = vi.fn();
  render(
    <JoinFlow
      port={port}
      deviceWord="phone"
      onDone={onDone}
      onVaultSealed={onVaultSealed}
      onLeave={onLeave}
      mediaDevices={blockedCamera}
    />,
  );
  return { onDone, onVaultSealed, onLeave };
}

async function typeSquareCode(text = "7KQ4 M2XD 9HTB") {
  fireEvent.change(await screen.findByTestId("join-typed-code"), { target: { value: text } });
  fireEvent.click(screen.getByTestId("join-typed-continue"));
}

async function toCode(port: FakeJoin) {
  await typeSquareCode();
  fireEvent.click(await screen.findByTestId("join-name-continue"));
  fireEvent.click(await screen.findByTestId("join-save-passkey"));
  return port;
}

describe("B1 — scan or type the square code", () => {
  it("a blocked camera says so and opens the typed code; the install line is shown first", async () => {
    renderJoin(fakeJoin());
    expect(screen.getByTestId("join-home-screen")).toHaveTextContent(
      "Using the app from your Home Screen? Add it there first, then open it from the icon.",
    );
    expect(
      await screen.findByText(
        "Camera is off for this app. Type the code instead, or allow the camera in Settings and start again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("join-typed-code")).toBeInTheDocument();
  });

  it("a code that does not decode stays on B1", async () => {
    const port = fakeJoin({ begin: false });
    renderJoin(port);
    await typeSquareCode("nope");
    expect(
      screen.getByText("That code isn't right. Check it on your other device and type it again."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("join-name-continue")).toBeNull();
  });
});

describe("B1 — a stray QR (UX review fix)", () => {
  it("a scanned QR that is not a pairing code says so and keeps the camera running", async () => {
    const port = fakeJoin({ begin: false });
    render(
      <JoinFlow
        port={port}
        deviceWord="phone"
        onDone={vi.fn()}
        onVaultSealed={vi.fn()}
        onLeave={vi.fn()}
        mediaDevices={scanningCamera}
      />,
    );
    fireEvent.click(await screen.findByTestId("fake-scan"));
    expect(
      screen.getByText(
        "That isn't the code from your other device. Point the camera at the square code on its screen.",
      ),
    ).toBeInTheDocument();
    expect(scanResults).toEqual([false]); // false: the scanner does not turn the camera off
    expect(screen.getByTestId("fake-scan")).toBeInTheDocument();
  });
});

describe("B1a — one combined name list, generic copy (A-13)", () => {
  it("lists all six names and does not name a password manager", async () => {
    renderJoin(fakeJoin());
    await typeSquareCode();
    await screen.findByTestId("join-name-continue");
    for (const label of DEVICE_LABELS) {
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }
    expect(
      screen.getByText(
        "Your passkey will carry this name, so you can find it in your password manager later.",
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Bitwarden");
  });

  it("the name is set before the passkey is created (DN-1a label)", async () => {
    const port = fakeJoin();
    renderJoin(port);
    await typeSquareCode();
    fireEvent.click(await screen.findByRole("radio", { name: "Tablet" }));
    fireEvent.click(screen.getByTestId("join-name-continue"));
    fireEvent.click(await screen.findByTestId("join-save-passkey"));
    await waitFor(() => expect(port.calls).toContain("createPasskey"));
    expect(port.calls.indexOf("label:Tablet")).toBeLessThan(port.calls.indexOf("createPasskey"));
  });
});

describe("B2–B4", () => {
  it("B3 shows the matching code BEFORE the request is posted; B4 then opens the app", async () => {
    const port = fakeJoin();
    const { onDone, onVaultSealed } = renderJoin(port);
    await toCode(port);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(port.device));
    expect(port.codeShownAtPost).toBe(true);
    expect(onVaultSealed).toHaveBeenCalledWith(port.device);
    expect(screen.getByTestId("join-done")).toHaveTextContent(
      "This phone is set up. It unlocks with your passkey.",
    );
    expect(screen.getByText("Getting your data… 1 moment")).toBeInTheDocument();
  });

  it("Style W: the passphrase step, then the code", async () => {
    const port = fakeJoin({ tier: "passphrase", poll: "waiting" });
    renderJoin(port);
    await toCode(port);
    expect(
      await screen.findByText(
        "Your password manager's passkey can't unlock the app by itself yet, so you'll also set a passphrase.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("passphrase"), { target: { value: "blue7kites" } });
    fireEvent.change(screen.getByTestId("passphrase-again"), { target: { value: "blue7kites" } });
    fireEvent.click(screen.getByTestId("save-passphrase"));
    expect(await screen.findByTestId("join-matching-code")).toHaveTextContent(
      "3f9a - 0c71 - be24 - d58e",
    );
    expect(port.calls).toContain("seal:blue7kites");
  });

  it("a taken or expired slot: 'Pairing interrupted — start again on your other device'", async () => {
    const port = fakeJoin({ post: "interrupted" });
    const { onLeave } = renderJoin(port);
    await toCode(port);
    expect(
      await screen.findByText("Pairing interrupted — start again on your other device."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("join-matching-code")).toBeNull();
    fireEvent.click(screen.getByTestId("join-leave"));
    expect(onLeave).toHaveBeenCalled();
  });

  it("no grant before the time ran out: interrupted", async () => {
    const port = fakeJoin({ poll: "interrupted" });
    renderJoin(port);
    await toCode(port);
    expect(
      await screen.findByText(
        "Pairing interrupted — start again on your other device.",
        {},
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
  });

  it("another window is already setting this device up: the busy line, no passkey", async () => {
    const busy = new Error("setup is running in another window");
    busy.name = "SetupBusyError";
    const port = fakeJoin({ createError: busy });
    renderJoin(port);
    await toCode(port);
    expect(
      await screen.findByText(
        "This device is being set up in another window. Finish there, or close that window and open the app again.",
      ),
    ).toBeInTheDocument();
    expect(port.calls).not.toContain("seal:");
  });
});
