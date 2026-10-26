// EU-7 (TEACH-73) — the F1 screens (design/flows-device-enrollment.md §3, S0–S6 and
// E-S1..E-S7; device-enrollment-spec rev 2.5 §4.1, DN-1a C6/C8/C10, §13 A-2). A fake
// SetupPort records the order of the port calls; the real port is tested in
// device/first-setup.test.ts.

import type { VaultTier } from "@teacher-assistant/crypto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeviceHandle, SetupPort } from "../../device/device-port.js";
import type { RedeemStep } from "../../device/first-setup.js";
import type { TeacherDeviceLabel } from "../../device/passkey-prf.js";
import { SetupFlow } from "./SetupFlow.js";

const SETUP_CODE = "7KQ4-M2XD-9HTB-R0WC-4FNA-Q8VJ-2E";
const RECOVERY = "7KQ4-M2XD-9HTB-R0WC-4FNA-Q8VJ-2EPS-K6YM";

function fakePort(
  options: {
    tier?: VaultTier;
    redeem?: RedeemStep[];
    createError?: Error;
    finishError?: Error;
  } = {},
) {
  const calls: string[] = [];
  const outcomes = [...(options.redeem ?? ["first"])];
  let label: TeacherDeviceLabel | undefined;
  const device: DeviceHandle = { locked: false, lock: () => {} };
  const port: SetupPort = {
    get label() {
      return label;
    },
    setLabel: (l) => {
      calls.push(`label:${l}`);
      label = l;
    },
    createPasskey: () => {
      calls.push(`createPasskey:${label ?? "none"}`);
      return options.createError === undefined
        ? Promise.resolve(options.tier ?? "passphrase")
        : Promise.reject(options.createError);
    },
    sealVault: (passphrase) => {
      calls.push(`sealVault:${passphrase ?? "-"}`);
      return Promise.resolve({ persisted: true });
    },
    redeem: (code) => {
      calls.push(`redeem:${code}`);
      return Promise.resolve(outcomes.shift() ?? "first");
    },
    finish: () => {
      calls.push("finish");
      return options.finishError === undefined
        ? Promise.resolve()
        : Promise.reject(options.finishError);
    },
    issueRecoveryCode: () => {
      calls.push("issueRecoveryCode");
      return Promise.resolve(RECOVERY);
    },
    confirmRecoveryCode: (typed) => {
      calls.push(`confirm:${typed}`);
      return Promise.resolve(typed.toUpperCase() === "2EPSK6YM");
    },
    discardRecoveryCode: () => {
      calls.push("discard");
    },
    end: () => {
      calls.push("end");
    },
    device,
  };
  return { port, calls, device };
}

function renderFlow(port: SetupPort, onDone = vi.fn()) {
  render(
    <SetupFlow port={port} resumeAt={null} online={true} deviceWord="laptop" onDone={onDone} />,
  );
  return onDone;
}

async function toPasskeyStep() {
  fireEvent.click(screen.getByTestId("setup-start"));
  fireEvent.change(screen.getByTestId("setup-code"), { target: { value: SETUP_CODE } });
  fireEvent.click(screen.getByTestId("code-continue"));
  fireEvent.click(screen.getByRole("radio", { name: "Home computer" }));
  fireEvent.click(screen.getByTestId("name-continue"));
  await screen.findByTestId("save-passkey");
}

async function toRecoveryCode() {
  await toPasskeyStep();
  fireEvent.click(screen.getByTestId("save-passkey"));
  await screen.findByTestId("passphrase");
  fireEvent.change(screen.getByTestId("passphrase"), { target: { value: "blue7kites" } });
  fireEvent.change(screen.getByTestId("passphrase-again"), { target: { value: "blue7kites" } });
  fireEvent.click(screen.getByTestId("save-passphrase"));
  await screen.findByTestId("recovery-code");
}

describe("F1 screens — order and the passkey name", () => {
  it("S0 → S1 → S1a → S2: the name is chosen BEFORE the passkey is created, and labels it", async () => {
    const { port, calls } = fakePort();
    renderFlow(port);
    expect(screen.getByText(/Let's set up this laptop/)).toBeInTheDocument();
    expect(screen.getByTestId("install-first")).toHaveTextContent(
      "First, install the app: tap Install in your browser's menu. Then come back here.",
    );
    await toPasskeyStep();
    expect(calls).toEqual(["label:Home computer"]);
    fireEvent.click(screen.getByTestId("save-passkey"));
    await screen.findByTestId("passphrase");
    expect(calls).toEqual(["label:Home computer", "createPasskey:Home computer"]);
  });

  it("S1a offers exactly the fixed list (no free typing), default from screen size", () => {
    const { port } = fakePort();
    renderFlow(port);
    fireEvent.click(screen.getByTestId("setup-start"));
    fireEvent.change(screen.getByTestId("setup-code"), { target: { value: SETUP_CODE } });
    fireEvent.click(screen.getByTestId("code-continue"));
    const options = screen.getAllByRole("radio").map((b) => (b as HTMLInputElement).value);
    expect(options).toEqual(["Phone", "Tablet", "Home computer", "School computer"]);
    expect(screen.getByRole("radio", { name: "School computer" })).toBeChecked();
    expect(screen.queryByRole("textbox", { name: /name/i })).toBeNull();
  });

  it("S1 groups the code as typed and enables Continue at 26 characters", () => {
    const { port } = fakePort();
    renderFlow(port);
    fireEvent.click(screen.getByTestId("setup-start"));
    const field = screen.getByTestId("setup-code");
    fireEvent.change(field, { target: { value: "7kq4m2xd" } });
    expect(field).toHaveValue("7KQ4-M2XD");
    expect(screen.getByTestId("code-continue")).toBeDisabled();
    fireEvent.change(field, { target: { value: SETUP_CODE.toLowerCase() } });
    expect(screen.getByTestId("code-continue")).toBeEnabled();
  });
});

describe("F1 screens — Style W (no PRF: Bitwarden)", () => {
  it("shows the one-line reason, then the passphrase; its box is not focused on load (C10)", async () => {
    const { port } = fakePort({ tier: "passphrase" });
    renderFlow(port);
    await toPasskeyStep();
    fireEvent.click(screen.getByTestId("save-passkey"));
    expect(await screen.findByTestId("style-w-line")).toHaveTextContent(
      "Your password manager's passkey can't unlock the app by itself yet, so you'll also set a passphrase.",
    );
    expect(document.activeElement).not.toBe(screen.getByTestId("passphrase"));
    expect(screen.queryByText(/local only|never leaves/i)).toBeNull(); // C12
  });

  it("refuses a 6-digit PIN and a mismatch inline; the vault is sealed only with a valid pair", async () => {
    const { port, calls } = fakePort({ tier: "passphrase" });
    renderFlow(port);
    await toPasskeyStep();
    fireEvent.click(screen.getByTestId("save-passkey"));
    await screen.findByTestId("passphrase");
    fireEvent.change(screen.getByTestId("passphrase"), { target: { value: "123456" } });
    fireEvent.change(screen.getByTestId("passphrase-again"), { target: { value: "123456" } });
    fireEvent.click(screen.getByTestId("save-passphrase"));
    expect(screen.getByTestId("passphrase-error")).toHaveTextContent(
      "Use at least 8 characters with letters and numbers, or at least 10 numbers.",
    );
    fireEvent.change(screen.getByTestId("passphrase"), { target: { value: "blue7kites" } });
    fireEvent.change(screen.getByTestId("passphrase-again"), { target: { value: "blue7kitez" } });
    fireEvent.click(screen.getByTestId("save-passphrase"));
    expect(screen.getByTestId("passphrase-error")).toHaveTextContent(
      "The two passphrases don't match.",
    );
    expect(calls.some((c) => c.startsWith("sealVault"))).toBe(false);
  });

  it("seals the vault, checks the code, finishes, then shows the recovery code", async () => {
    const { port, calls } = fakePort({ tier: "passphrase" });
    renderFlow(port);
    await toRecoveryCode();
    expect(calls).toEqual([
      "label:Home computer",
      "createPasskey:Home computer",
      "sealVault:blue7kites",
      `redeem:${SETUP_CODE}`,
      "finish",
      "issueRecoveryCode",
    ]);
  });
});

describe("F1 screens — Style P (a provider with PRF)", () => {
  it("skips the passphrase and says the device unlocks with the passkey", async () => {
    const { port, calls } = fakePort({ tier: "prf" });
    renderFlow(port);
    await toPasskeyStep();
    fireEvent.click(screen.getByTestId("save-passkey"));
    await screen.findByTestId("recovery-code");
    expect(screen.queryByTestId("passphrase")).toBeNull();
    expect(calls).toContain("sealVault:-");
    expect(screen.getByText(/Passkey saved. This laptop unlocks with it./)).toBeInTheDocument();
  });
});

describe("F1 screens — the paper recovery code (C6, D-ARCH-1)", () => {
  it("S4 says paper only, never Bitwarden; no copy or print button; the banner shows", async () => {
    const { port } = fakePort();
    renderFlow(port);
    await toRecoveryCode();
    expect(screen.getByTestId("recovery-code")).toHaveTextContent("7KQ4 M2XD 9HTB R0WC");
    expect(screen.getByText(/Write it on paper/)).toBeInTheDocument();
    expect(
      screen.getByText("✕ Don't save it in Bitwarden or any password manager."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy|print/i })).toBeNull();
    expect(screen.getByTestId("recovery-banner")).toHaveTextContent(
      "Recovery code not saved yet — finish setup.",
    );
  });

  it("S5 masks the first six groups, refuses a wrong re-type, and a match reaches S6", async () => {
    const { port, calls } = fakePort();
    const onDone = renderFlow(port);
    await toRecoveryCode();
    fireEvent.click(screen.getByTestId("wrote-it-down"));
    expect(screen.queryByText(/7KQ4/)).toBeNull(); // masked once S4 is left
    fireEvent.change(screen.getByTestId("check-group-1"), { target: { value: "AAAA" } });
    fireEvent.change(screen.getByTestId("check-group-2"), { target: { value: "BBBB" } });
    fireEvent.click(screen.getByTestId("check-recovery"));
    expect(await screen.findByTestId("check-wrong")).toHaveTextContent(
      "That doesn't match. Look at your paper again — the last two groups.",
    );
    expect(screen.getByTestId("recovery-banner")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("check-group-1"), { target: { value: "2eps" } });
    fireEvent.change(screen.getByTestId("check-group-2"), { target: { value: "k6ym" } });
    fireEvent.click(screen.getByTestId("check-recovery"));
    await screen.findByText("This laptop is set up");
    expect(screen.queryByTestId("recovery-banner")).toBeNull();
    expect(calls).toContain("confirm:2epsk6ym");
    fireEvent.click(screen.getByTestId("setup-done"));
    expect(onDone).toHaveBeenCalledWith(port.device, false);
  });

  it("S5 'Show the code again' returns to S4 while still in this setup", async () => {
    const { port } = fakePort();
    renderFlow(port);
    await toRecoveryCode();
    fireEvent.click(screen.getByTestId("wrote-it-down"));
    fireEvent.click(screen.getByRole("button", { name: "‹ Show the code again" }));
    expect(screen.getByTestId("recovery-code")).toBeInTheDocument();
  });
});

describe("F1 screens — errors", () => {
  it("E-S1: a refused code returns to S1 with the code kept; the retry reuses the unlock setup", async () => {
    const { port, calls } = fakePort({ redeem: ["refused", "first"] });
    renderFlow(port);
    await toPasskeyStep();
    fireEvent.click(screen.getByTestId("save-passkey"));
    await screen.findByTestId("passphrase");
    fireEvent.change(screen.getByTestId("passphrase"), { target: { value: "blue7kites" } });
    fireEvent.change(screen.getByTestId("passphrase-again"), { target: { value: "blue7kites" } });
    fireEvent.click(screen.getByTestId("save-passphrase"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That setup code didn't work. Codes work once and last 24 hours.",
    );
    expect(screen.getByTestId("setup-code")).toHaveValue(SETUP_CODE);
    fireEvent.click(screen.getByTestId("code-continue"));
    await screen.findByTestId("recovery-code");
    expect(calls.filter((c) => c.startsWith("createPasskey"))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("sealVault"))).toHaveLength(1);
  });

  it("E-S7: an existing account goes to recovery, and nothing finishes or is minted here", async () => {
    const { port, calls } = fakePort({ tier: "prf", redeem: ["recovery"] });
    renderFlow(port);
    await toPasskeyStep();
    fireEvent.click(screen.getByTestId("save-passkey"));
    expect(await screen.findByTestId("recovery-mode")).toHaveTextContent(
      "You already have an account. Let's get your data back.",
    );
    expect(screen.queryAllByText(/You already have an account/)).toHaveLength(1);
    expect(calls).not.toContain("finish");
    expect(calls).not.toContain("issueRecoveryCode");
  });

  it("E-S3: offline at the code check asks to connect, and retries on demand", async () => {
    const { port, calls } = fakePort({ tier: "prf", redeem: ["offline", "first"] });
    renderFlow(port);
    await toPasskeyStep();
    fireEvent.click(screen.getByTestId("save-passkey"));
    await screen.findByTestId("setup-retry");
    // The copy shows once, as the screen's body — never repeated as the error line.
    expect(screen.getAllByText("Connect to the internet to finish setup.")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("");
    fireEvent.click(screen.getByTestId("setup-retry"));
    await screen.findByTestId("recovery-code");
    expect(calls.filter((c) => c.startsWith("redeem"))).toHaveLength(2);
  });
});

describe("F1 screens — resume (after the full unlock)", () => {
  it("recovery_pending opens on a NEW recovery code with the E-S6 line (A-2)", async () => {
    const { port, calls } = fakePort();
    render(
      <SetupFlow
        port={port}
        resumeAt="recovery_pending"
        online={true}
        deviceWord="phone"
        onDone={vi.fn()}
      />,
    );
    await screen.findByTestId("recovery-code");
    expect(screen.getByTestId("recovery-reissued")).toHaveTextContent(
      "For safety, here is a new recovery code. Throw away the old one.",
    );
    expect(calls).toEqual(["issueRecoveryCode"]);
  });

  it("keys_created asks for the code again, then the name, without a new passkey", async () => {
    const { port, calls } = fakePort();
    render(
      <SetupFlow
        port={port}
        resumeAt="keys_created"
        online={true}
        deviceWord="phone"
        onDone={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("setup-code"), { target: { value: SETUP_CODE } });
    fireEvent.click(screen.getByTestId("code-continue"));
    fireEvent.click(screen.getByTestId("name-continue"));
    await waitFor(() => expect(calls).toContain("issueRecoveryCode"));
    expect(calls.some((c) => c.startsWith("createPasskey"))).toBe(false);
    expect(calls.some((c) => c.startsWith("sealVault"))).toBe(false);
    expect(calls).toContain("label:Phone");
  });
});

describe("F1 screens — review fixes", () => {
  it("S6 offers 'Add my phone now' and 'Later' now that pairing exists (EU-8)", async () => {
    const { port } = fakePort({ tier: "prf" });
    const onDone = renderFlow(port);
    await toPasskeyStep();
    fireEvent.click(screen.getByTestId("save-passkey"));
    fireEvent.click(await screen.findByTestId("wrote-it-down"));
    fireEvent.change(screen.getByTestId("check-group-1"), { target: { value: "2EPS" } });
    fireEvent.change(screen.getByTestId("check-group-2"), { target: { value: "K6YM" } });
    fireEvent.click(screen.getByTestId("check-recovery"));
    expect(await screen.findByTestId("setup-done")).toHaveTextContent("Later");
    expect(screen.getByText("Want the app on your phone too?")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("setup-add-phone"));
    expect(onDone).toHaveBeenCalledWith(port.device, true);
  });

  it("E-S5: a device that cannot save a passkey at all gets its own copy", async () => {
    const unsupported = new Error("not supported");
    unsupported.name = "NotSupportedError";
    const { port } = fakePort({ createError: unsupported });
    renderFlow(port);
    await toPasskeyStep();
    fireEvent.click(screen.getByTestId("save-passkey"));
    expect(await screen.findByText(/This device can't save a passkey yet/)).toBeInTheDocument();
  });

  it("E-S4: a cancelled passkey prompt keeps the retry copy", async () => {
    const cancelled = new Error("cancelled");
    cancelled.name = "UserVerificationError";
    const { port } = fakePort({ createError: cancelled });
    renderFlow(port);
    await toPasskeyStep();
    fireEvent.click(screen.getByTestId("save-passkey"));
    expect(await screen.findByText(/Try your passkey again/)).toBeInTheDocument();
  });

  it("a definite refusal of the self-grant stops with 'text Neil', not a retry loop", async () => {
    const refused = new Error("refused");
    refused.name = "SetupRefusedError";
    const { port } = fakePort({ tier: "prf", finishError: refused });
    renderFlow(port);
    await toPasskeyStep();
    fireEvent.click(screen.getByTestId("save-passkey"));
    expect(await screen.findByTestId("setup-stopped")).toHaveTextContent(
      "Setup can't finish on this device — text Neil.",
    );
    // No leftover S2 result line contradicts the stop (UX N1).
    expect(screen.queryByText(/Passkey saved/)).toBeNull();
    expect(screen.queryByTestId("setup-retry")).toBeNull();
  });

  it("the vault hand-off fires once the vault is sealed, with the setup's device", async () => {
    const { port, device } = fakePort({ tier: "prf" });
    const onVaultSealed = vi.fn();
    render(
      <SetupFlow
        port={port}
        resumeAt={null}
        online={true}
        deviceWord="laptop"
        onDone={vi.fn()}
        onVaultSealed={onVaultSealed}
      />,
    );
    await toPasskeyStep();
    expect(onVaultSealed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("save-passkey"));
    await screen.findByTestId("recovery-code");
    expect(onVaultSealed).toHaveBeenCalledWith(device);
  });

  it("A-3: on iOS outside the Home Screen app, S0 has no setup controls", () => {
    const { port } = fakePort();
    render(
      <SetupFlow
        port={port}
        resumeAt={null}
        online={true}
        deviceWord="phone"
        onDone={vi.fn()}
        homeScreenOnly={true}
      />,
    );
    expect(screen.getByTestId("home-screen-first")).toHaveTextContent(
      "Add to Home Screen first, then open the app from the icon.",
    );
    expect(screen.queryByTestId("setup-start")).toBeNull();
  });
});
