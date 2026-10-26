// EU-7 (TEACH-73) — the App around first setup (device-enrollment-spec rev 2.5 §3.4, §4.1,
// §13 A-2/A-8; EU-6 FERPA carry-forward "the App's lock also locks the device"):
//   - no device record → first setup; no student data before setup is done;
//   - a finished setup opens the session with the device setup unlocked;
//   - an unfinished setup resumes only after the full unlock;
//   - every lock locks the device as well as both sessions.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { BootstrapOptions, Session } from "./data/session.js";
import { buildSyntheticSeed } from "./data/synthetic-seed.js";
import type { DeviceHandle, SetupPort } from "./device/device-port.js";
import { fakeDevicePort } from "./test/fake-device.js";
import { makeFakeParaSession, makeFakeSession } from "./test/fake-session.js";

const RECOVERY = "7KQ4-M2XD-9HTB-R0WC-4FNA-Q8VJ-2EPS-K6YM";
const MIN = 60_000;

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Leave the page for longer than the hidden-page limit and come back (flows U3). */
function leaveAndReturn() {
  const t0 = Date.now();
  const now = vi.spyOn(Date, "now");
  now.mockReturnValue(t0);
  act(() => setVisibility("hidden"));
  now.mockReturnValue(t0 + 2 * MIN + 1);
  act(() => setVisibility("visible"));
  now.mockRestore();
}

afterEach(() => {
  setVisibility("visible");
});

function bootstrap(_options: BootstrapOptions): Promise<Session> {
  return Promise.resolve(makeFakeSession(buildSyntheticSeed(new Date())));
}

/** A setup port that completes at once (Style P), on the given device handle. */
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
    issueRecoveryCode: () => Promise.resolve(RECOVERY),
    confirmRecoveryCode: (typed) => Promise.resolve(typed.toUpperCase() === "2EPSK6YM"),
    discardRecoveryCode: () => {},
    device,
  };
}

function lockable(): DeviceHandle & { readonly count: () => number } {
  let locks = 0;
  let locked = false;
  return {
    get locked() {
      return locked;
    },
    lock: () => {
      locks += 1;
      locked = true;
    },
    count: () => locks,
  };
}

async function completeSetup() {
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
  fireEvent.click(await screen.findByTestId("setup-done"));
}

describe("App — first setup", () => {
  it("a device with no record opens on setup, never on student data", async () => {
    const handle = lockable();
    const device = fakeDevicePort({
      status: { kind: "none", cleared: false },
      setup: () => quickSetup(handle),
    });
    render(<App device={device} bootstrap={bootstrap} bootstrapPara={makeFakeParaSession} />);
    expect(await screen.findByText(/I have a setup code from Neil/)).toBeInTheDocument();
    expect(screen.queryByTestId("header-line")).toBeNull();
    expect(screen.queryByTestId("unlock")).toBeNull();
  });

  it("finishing setup opens the dashboard without a second unlock", async () => {
    const handle = lockable();
    const bootstrapSpy = vi.fn(bootstrap);
    const device = fakeDevicePort({
      status: { kind: "none", cleared: false },
      setup: () => quickSetup(handle),
    });
    render(<App device={device} bootstrap={bootstrapSpy} bootstrapPara={makeFakeParaSession} />);
    await completeSetup();
    await screen.findByTestId("header-line");
    expect(device.unlockedWith).toHaveLength(0);
    expect(bootstrapSpy).toHaveBeenCalledTimes(1);
  });

  it("an expired unfinished setup that was cleared says so on the welcome screen (A-8)", async () => {
    const device = fakeDevicePort({
      status: { kind: "none", cleared: true },
      setup: () => quickSetup(lockable()),
    });
    render(<App device={device} bootstrap={bootstrap} />);
    expect(await screen.findByText("Start over with a new setup code.")).toBeInTheDocument();
  });
});

describe("App — resume after the full unlock (A-2, A-8)", () => {
  it("an unfinished setup shows the lock screen first; setup resumes only after unlock", async () => {
    const handle = lockable();
    const setup = vi.fn((_device?: DeviceHandle) => quickSetup(handle));
    const device = fakeDevicePort({
      status: { kind: "enrolled", tier: "prf", stage: "recovery_pending" },
      setup,
      unlock: () => Promise.resolve(handle),
    });
    render(<App device={device} bootstrap={bootstrap} bootstrapPara={makeFakeParaSession} />);
    const unlock = await screen.findByTestId("unlock");
    expect(setup).not.toHaveBeenCalled();
    fireEvent.click(unlock);
    expect(await screen.findByTestId("recovery-reissued")).toBeInTheDocument();
    expect(setup).toHaveBeenCalledWith(handle);
  });
});

describe("App — lock locks the device too (EU-6 carry-forward)", () => {
  it("the Lock button locks the sessions and the unlocked device", async () => {
    const device = fakeDevicePort();
    render(<App device={device} bootstrap={bootstrap} bootstrapPara={makeFakeParaSession} />);
    fireEvent.click(await screen.findByTestId("unlock"));
    await screen.findByTestId("header-line");
    fireEvent.click(screen.getByTestId("lock"));
    expect(device.locks()).toBe(1);
    expect(screen.getByTestId("unlock")).toBeInTheDocument();
  });

  it("a failed bootstrap locks the device it unlocked", async () => {
    const device = fakeDevicePort();
    render(
      <App
        device={device}
        bootstrap={() => Promise.reject(new Error("grant unwrap failed"))}
        bootstrapPara={makeFakeParaSession}
      />,
    );
    fireEvent.click(await screen.findByTestId("unlock"));
    await waitFor(() => expect(device.locks()).toBe(1));
  });
});

describe("App — Style W unlock", () => {
  it("passes the passphrase from the box to the unlock ceremony", async () => {
    const device = fakeDevicePort({ tier: "passphrase" });
    render(<App device={device} bootstrap={bootstrap} bootstrapPara={makeFakeParaSession} />);
    const box = await screen.findByTestId("unlock-passphrase");
    fireEvent.change(box, { target: { value: "blue7kites" } });
    fireEvent.click(screen.getByTestId("unlock"));
    await screen.findByTestId("header-line");
    expect(device.unlockedWith).toEqual(["blue7kites"]);
  });
});

describe("App — production build has no role switch without an in-process para device", () => {
  it("hides the Teacher/Para switch when the session has no para handoff (A-6)", async () => {
    const noPara = (_o: BootstrapOptions): Promise<Session> =>
      Promise.resolve({ ...makeFakeSession(buildSyntheticSeed(new Date())), paraHandoff: null });
    render(<App device={fakeDevicePort()} bootstrap={noPara} />);
    fireEvent.click(await screen.findByTestId("unlock"));
    await screen.findByTestId("header-line");
    expect(screen.queryByTestId("role-para")).toBeNull();
  });
});

describe("App — review fixes (FERPA B1/B3, races)", () => {
  it("B1: once the vault exists, a hidden-page lock during setup locks the device and drops the code", async () => {
    const handle = lockable();
    const device = fakeDevicePort({
      status: { kind: "none", cleared: false },
      setup: () => quickSetup(handle),
    });
    render(<App device={device} bootstrap={bootstrap} bootstrapPara={makeFakeParaSession} />);
    fireEvent.click(await screen.findByTestId("setup-start"));
    fireEvent.change(screen.getByTestId("setup-code"), {
      target: { value: "7KQ4-M2XD-9HTB-R0WC-4FNA-Q8VJ-2E" },
    });
    fireEvent.click(screen.getByTestId("code-continue"));
    fireEvent.click(screen.getByTestId("name-continue"));
    fireEvent.click(await screen.findByTestId("save-passkey"));
    await screen.findByTestId("recovery-code"); // S4, code on screen
    await act(async () => {}); // let the auto-lock effect start
    leaveAndReturn();
    expect(handle.count()).toBe(1);
    expect(screen.queryByTestId("recovery-code")).toBeNull();
    expect(screen.getByTestId("unlock")).toBeInTheDocument();
  });

  it("B3: a status read that fails after unlock never opens data; the device locks again", async () => {
    const handle = lockable();
    let reads = 0;
    const device = {
      ...fakeDevicePort({ unlock: () => Promise.resolve(handle) }),
      status: () => {
        reads += 1;
        return reads === 1
          ? Promise.resolve({
              kind: "enrolled" as const,
              tier: "prf" as const,
              stage: "done" as const,
            })
          : Promise.reject(new Error("IndexedDB read failed"));
      },
    };
    const bootstrapSpy = vi.fn(bootstrap);
    render(<App device={device} bootstrap={bootstrapSpy} bootstrapPara={makeFakeParaSession} />);
    fireEvent.click(await screen.findByTestId("unlock"));
    await waitFor(() => expect(handle.count()).toBe(1));
    expect(bootstrapSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("header-line")).toBeNull();
  });

  it("a device whose setup was cleared at unlock goes back to setup, not to a dead lock screen", async () => {
    const handle = lockable();
    let reads = 0;
    const device = {
      ...fakeDevicePort({
        unlock: () => Promise.resolve(handle),
        setup: () => quickSetup(lockable()),
      }),
      status: () => {
        reads += 1;
        return Promise.resolve(
          reads === 1
            ? { kind: "enrolled" as const, tier: "prf" as const, stage: "keys_created" as const }
            : { kind: "none" as const, cleared: true },
        );
      },
    };
    render(<App device={device} bootstrap={bootstrap} />);
    fireEvent.click(await screen.findByTestId("unlock"));
    expect(await screen.findByText("Start over with a new setup code.")).toBeInTheDocument();
    expect(handle.count()).toBe(1);
  });

  it("a lock that lands while the session is opening keeps the session off screen and locks it", async () => {
    let release: (s: Session) => void = () => {};
    const teacherLocks = { count: 0 };
    const pending = (_o: BootstrapOptions) =>
      new Promise<Session>((resolve) => {
        release = resolve;
      });
    const device = fakeDevicePort();
    render(<App device={device} bootstrap={pending} bootstrapPara={makeFakeParaSession} />);
    fireEvent.click(await screen.findByTestId("unlock"));
    await waitFor(() => expect(device.unlockedWith).toHaveLength(1));
    await act(async () => {}); // the auto-lock starts once the device is open
    leaveAndReturn();
    expect(device.locks()).toBe(1);
    const base = makeFakeSession(buildSyntheticSeed(new Date()));
    await act(async () => {
      release({
        ...base,
        lock: () => {
          teacherLocks.count += 1;
        },
      });
    });
    expect(teacherLocks.count).toBe(1);
    expect(screen.queryByTestId("header-line")).toBeNull();
  });
});
