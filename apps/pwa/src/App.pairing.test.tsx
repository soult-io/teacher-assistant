// EU-8 (TEACH-75) — the App around pairing (spec rev 2.7 §4.2, §11 EU-8; flows §5, S0/S6):
//   - S0 "Add this device to my account" opens the new device's pairing (B1);
//   - S6 "Add my phone now" opens the app straight on the square code (A1);
//   - ⚙ Devices ▸ Add a device opens A0 on a set-up teacher device;
//   - a lock abandons the trusted side's session and discards a new device's keys;
//   - another window setting this device up: a busy screen, the record left alone;
//   - a pairing no window runs any more: back to S0 with "Pairing interrupted".

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { BootstrapOptions, Session } from "./data/session.js";
import { buildSyntheticSeed } from "./data/synthetic-seed.js";
import type { ApprovePort, DeviceHandle, JoinPort, SetupPort } from "./device/device-port.js";
import type { DeviceStatus } from "./device/first-setup.js";
import { fakeDevicePort } from "./test/fake-device.js";
import { makeFakeParaSession, makeFakeSession } from "./test/fake-session.js";

const SQUARE = "7KQ4-M2XD-9HTB-R0WC-4FNA-Q8VJ-2EPS-K6YM-3JR5-WZ0D-H7GA-PB4N-XC2T";

function bootstrap(_options: BootstrapOptions): Promise<Session> {
  return Promise.resolve(makeFakeSession(buildSyntheticSeed(new Date())));
}

function handle(): DeviceHandle {
  let locked = false;
  return {
    get locked() {
      return locked;
    },
    lock: () => {
      locked = true;
    },
  };
}

function recordingApprover(calls: string[]): ApprovePort {
  return {
    open: () => {
      calls.push("open");
      return Promise.resolve({ kind: "open", code: SQUARE, expiresAt: Date.now() + 600_000 });
    },
    poll: () => Promise.resolve({ kind: "waiting" }),
    checkCode: () => "mismatch",
    approve: () => Promise.resolve({ kind: "added", label: "Phone" }),
    abandon: () => {
      calls.push("abandon");
    },
  };
}

function recordingJoin(calls: string[], device: DeviceHandle, done = false): JoinPort {
  let label: JoinPort["label"];
  return {
    begin: () => true,
    get label() {
      return label;
    },
    setLabel: (l) => {
      label = l;
    },
    createPasskey: () => Promise.resolve("prf"),
    sealVault: () => Promise.resolve({ persisted: true, code: "3f9a-0c71-be24-d58e" }),
    postRequest: () => {
      calls.push("post");
      return Promise.resolve("waiting");
    },
    poll: () => Promise.resolve(done ? "done" : "waiting"),
    discard: () => {
      calls.push("discard");
      return Promise.resolve();
    },
    device,
  };
}

function quickSetup(device: DeviceHandle): SetupPort {
  let label: SetupPort["label"];
  return {
    get label() {
      return label;
    },
    setLabel: (l) => {
      label = l;
    },
    createPasskey: () => Promise.resolve("prf"),
    sealVault: () => Promise.resolve({ persisted: true }),
    redeem: () => Promise.resolve("first"),
    finish: () => Promise.resolve(),
    issueRecoveryCode: () => Promise.resolve("7KQ4-M2XD-9HTB-R0WC-4FNA-Q8VJ-2EPS-K6YM"),
    confirmRecoveryCode: () => Promise.resolve(true),
    discardRecoveryCode: () => {},
    end: () => {},
    device,
  };
}

const none: DeviceStatus = { kind: "none", cleared: false };

async function toCodeScreen() {
  fireEvent.click(await screen.findByTestId("pair-start"));
  // jsdom has no camera: B1 falls back to the typed code at once.
  fireEvent.change(await screen.findByTestId("join-typed-code"), { target: { value: SQUARE } });
  fireEvent.click(screen.getByTestId("join-typed-continue"));
  fireEvent.click(await screen.findByTestId("join-name-continue"));
  fireEvent.click(await screen.findByTestId("join-save-passkey"));
}

describe("App — the new device's side (B)", () => {
  it("S0 offers 'Add this device to my account', which opens B1", async () => {
    const calls: string[] = [];
    const device = fakeDevicePort({
      status: none,
      setup: () => quickSetup(handle()),
      pair: () => recordingJoin(calls, handle()),
    });
    render(<App device={device} bootstrap={bootstrap} bootstrapPara={makeFakeParaSession} />);
    fireEvent.click(await screen.findByTestId("pair-start"));
    expect(await screen.findByTestId("join-step-scan")).toBeInTheDocument();
  });

  it("a paired device opens its session; no second unlock", async () => {
    const calls: string[] = [];
    const opened = vi.fn(bootstrap);
    const device = fakeDevicePort({
      status: none,
      setup: () => quickSetup(handle()),
      pair: () => recordingJoin(calls, handle(), true),
    });
    render(<App device={device} bootstrap={opened} bootstrapPara={makeFakeParaSession} />);
    await toCodeScreen();
    expect(await screen.findByTestId("header-line")).toBeInTheDocument();
    expect(opened).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("unlock")).toBeNull();
  });

  it("a lock while pairing discards the new device's keys", async () => {
    const calls: string[] = [];
    const device = fakeDevicePort({
      status: none,
      setup: () => quickSetup(handle()),
      pair: () => recordingJoin(calls, handle()),
    });
    render(<App device={device} bootstrap={bootstrap} bootstrapPara={makeFakeParaSession} />);
    await toCodeScreen();
    await screen.findByTestId("join-matching-code");
    await waitFor(() => expect(calls).toContain("post"));
    // The auto-lock is running from the vault seal on: leave the page past its limit.
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    now.mockReturnValue(t0 + 10 * 60_000);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    now.mockRestore();
    await waitFor(() => expect(calls).toContain("discard"));
    expect(screen.queryByTestId("join-matching-code")).toBeNull();
  });

  it("another window is setting this device up: the busy screen, nothing touched", async () => {
    const device = fakeDevicePort({ status: { kind: "busy" } });
    render(<App device={device} bootstrap={bootstrap} bootstrapPara={makeFakeParaSession} />);
    expect(await screen.findByTestId("setup-busy")).toHaveTextContent(
      "This device is being set up in another window.",
    );
    expect(screen.queryByTestId("unlock")).toBeNull();
    expect(screen.queryByTestId("setup-start")).toBeNull();
  });

  it("a pairing no window runs any more was cleared: S0 says 'Pairing interrupted'", async () => {
    const device = fakeDevicePort({
      status: { kind: "none", cleared: true, pairing: true },
      setup: () => quickSetup(handle()),
    });
    render(<App device={device} bootstrap={bootstrap} bootstrapPara={makeFakeParaSession} />);
    expect(
      await screen.findByText("Pairing interrupted — start again on your other device."),
    ).toBeInTheDocument();
  });
});

describe("App — the trusted device's side (A)", () => {
  it("⚙ Devices ▸ Add a device opens A0; a lock abandons the open session", async () => {
    const calls: string[] = [];
    const device = fakeDevicePort({ approver: () => recordingApprover(calls) });
    render(<App device={device} bootstrap={bootstrap} bootstrapPara={makeFakeParaSession} />);
    fireEvent.click(screen.getByTestId("unlock"));
    fireEvent.click(await screen.findByTestId("devices"));
    fireEvent.click(await screen.findByTestId("add-device"));
    fireEvent.click(await screen.findByTestId("add-mine"));
    expect(await screen.findByTestId("pair-qr")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("lock"));
    expect(await screen.findByTestId("unlock")).toBeInTheDocument();
    expect(calls.filter((c) => c === "open")).toHaveLength(1);
    expect(calls).toContain("abandon");
  });

  it("S6 'Add my phone now' opens the app straight on the square code", async () => {
    const calls: string[] = [];
    const device = fakeDevicePort({
      status: none,
      setup: () => quickSetup(handle()),
      approver: () => recordingApprover(calls),
    });
    render(<App device={device} bootstrap={bootstrap} bootstrapPara={makeFakeParaSession} />);
    fireEvent.click(await screen.findByTestId("setup-start"));
    fireEvent.change(screen.getByTestId("setup-code"), {
      target: { value: "7KQ4-M2XD-9HTB-R0WC-4FNA-Q8VJ-2E" },
    });
    fireEvent.click(screen.getByTestId("code-continue"));
    fireEvent.click(screen.getByTestId("name-continue"));
    fireEvent.click(await screen.findByTestId("save-passkey"));
    fireEvent.click(await screen.findByTestId("wrote-it-down"));
    fireEvent.change(screen.getByTestId("check-group-1"), { target: { value: "2EPS" } });
    fireEvent.change(screen.getByTestId("check-group-2"), { target: { value: "K6YM" } });
    fireEvent.click(screen.getByTestId("check-recovery"));
    fireEvent.click(await screen.findByTestId("setup-add-phone"));
    expect(await screen.findByTestId("pair-qr")).toBeInTheDocument();
    expect(calls).toEqual(["open"]);
  });
});
