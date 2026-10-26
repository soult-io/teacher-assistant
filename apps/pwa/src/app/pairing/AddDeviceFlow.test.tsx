// EU-8 (TEACH-75) — the trusted device's pairing screens A0–A4 (flows §5 Flow 3 laptop side;
// spec rev 2.7 §4.2, §11 EU-8, §13 A-4/A-5). A crypto-free ApprovePort stands in for the
// pairing layer (tested in process in device/pairing.test.ts).

import type { VaultTier } from "@teacher-assistant/crypto";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApprovePort } from "../../device/device-port.js";
import type {
  ApproveOutcome,
  CodeOutcome,
  OpenOutcome,
  PollOutcome,
} from "../../device/pairing.js";
import { WrongPassphraseError } from "../../device/vault.js";
import { AddDeviceFlow } from "./AddDeviceFlow.js";
import { qrPayload } from "./QrCode.js";

const SQUARE = "7KQ4-M2XD-9HTB-R0WC-4FNA-Q8VJ-2EPS-K6YM-3JR5-WZ0D-H7GA-PB4N-XC2T";
const CODE = "3f9a0c71be24d58e";

interface FakeApprover extends ApprovePort {
  readonly calls: string[];
  over: boolean;
}

function fakeApprover(
  options: {
    readonly open?: OpenOutcome;
    readonly poll?: PollOutcome;
    readonly approve?: () => Promise<ApproveOutcome>;
  } = {},
): FakeApprover {
  const calls: string[] = [];
  let misses = 0;
  return {
    calls,
    open: () => {
      calls.push("open");
      return Promise.resolve(
        options.open ?? { kind: "open", code: SQUARE, expiresAt: Date.now() + 600_000 },
      );
    },
    poll: () => {
      calls.push("poll");
      return Promise.resolve(options.poll ?? { kind: "arrived", label: "Phone" });
    },
    checkCode: (typed): CodeOutcome => {
      calls.push(`check:${typed}`);
      if (typed.toLowerCase() === CODE) {
        return "match";
      }
      misses += 1;
      return misses >= 3 ? "stopped" : "mismatch";
    },
    approve: (passphrase) => {
      calls.push(`approve:${passphrase ?? ""}`);
      return options.approve?.() ?? Promise.resolve({ kind: "added", label: "Phone" });
    },
    abandon: () => {
      calls.push("abandon");
    },
    over: false,
  };
}

function renderFlow(port: ApprovePort, tier: VaultTier = "prf", online = true) {
  const onClose = vi.fn();
  const view = render(
    <AddDeviceFlow
      openApprover={() => port}
      tier={tier}
      online={online}
      deviceWord="laptop"
      onClose={onClose}
    />,
  );
  return { onClose, ...view };
}

function typeCode(code: string) {
  for (let i = 0; i < 4; i += 1) {
    fireEvent.change(screen.getByTestId(`matching-code-${i + 1}`), {
      target: { value: code.slice(i * 4, i * 4 + 4) },
    });
  }
}

async function toMatch(port: FakeApprover) {
  fireEvent.click(screen.getByTestId("add-mine"));
  await screen.findByTestId("pair-approve");
  return port;
}

describe("A0 — whose device (release 1)", () => {
  it("offers her own device only: no para choice", () => {
    renderFlow(fakeApprover());
    expect(screen.getByTestId("add-mine")).toHaveTextContent(
      "My phone or another computer of mine",
    );
    expect(screen.queryByText(/para/i)).toBeNull();
  });

  it("offline: the choice is disabled and says why", () => {
    renderFlow(fakeApprover(), "prf", false);
    expect(screen.getByTestId("add-mine")).toBeDisabled();
    expect(
      screen.getByText("Adding a device needs the internet. Connect and try again."),
    ).toBeInTheDocument();
  });

  it("3 sessions already waiting on the relay: 'Too many devices waiting'", async () => {
    renderFlow(fakeApprover({ open: { kind: "too_many" } }));
    fireEvent.click(screen.getByTestId("add-mine"));
    expect(
      await screen.findByText("Too many devices waiting. Wait 10 minutes, then try again."),
    ).toBeInTheDocument();
  });
});

describe("A1 — the square code (A-5)", () => {
  it("shows the QR and the typed code; the QR carries the raw code, not a link", async () => {
    renderFlow(fakeApprover({ poll: { kind: "waiting" } }));
    fireEvent.click(screen.getByTestId("add-mine"));
    expect(await screen.findByTestId("pair-qr")).toBeInTheDocument();
    expect(screen.getByTestId("pair-typed-code")).toHaveTextContent(SQUARE.replace(/-/g, " "));
    expect(qrPayload(SQUARE)).toMatch(/^[0-9A-Z]{52}$/);
    expect(screen.getByText(/Waiting for your phone…/)).toBeInTheDocument();
  });

  it("time ran out: the session ends with 'Time ran out'", async () => {
    renderFlow(fakeApprover({ poll: { kind: "expired" } }));
    fireEvent.click(screen.getByTestId("add-mine"));
    expect(await screen.findByText("Time ran out. Start again.")).toBeInTheDocument();
    expect(screen.getByTestId("pair-restart")).toBeInTheDocument();
  });

  it("a tampered, garbled or wrongly named check-in: 'Pairing interrupted'", async () => {
    renderFlow(fakeApprover({ poll: { kind: "interrupted" } }));
    fireEvent.click(screen.getByTestId("add-mine"));
    expect(await screen.findByText("Pairing interrupted. Start again.")).toBeInTheDocument();
  });
});

describe("A2 — the matching code (A-4)", () => {
  it("Approve is disabled with 15 characters, enabled with 16; a paste fills every box", async () => {
    const port = fakeApprover();
    renderFlow(port);
    await toMatch(port);
    expect(screen.getByTestId("pair-approve")).toBeDisabled();
    typeCode(CODE.slice(0, 15));
    expect(screen.getByTestId("pair-approve")).toBeDisabled();
    fireEvent.change(screen.getByTestId("matching-code-1"), {
      target: { value: "3F9A-0C71-BE24-D58E" },
    });
    expect(screen.getByTestId("pair-approve")).toBeEnabled();
    fireEvent.click(screen.getByTestId("pair-approve"));
    expect(port.calls).toContain("check:3F9A0C71BE24D58E");
    expect(await screen.findByTestId("pair-confirm")).toBeInTheDocument();
  });

  it("a wrong code says so without hinting at the right one, and clears the boxes", async () => {
    const port = fakeApprover();
    renderFlow(port);
    await toMatch(port);
    typeCode("ffffffffffffffff");
    fireEvent.click(screen.getByTestId("pair-approve"));
    expect(
      screen.getByText("That code doesn't match your phone. Check your phone and type it again."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("matching-code-1")).toHaveValue("");
    expect(document.body.textContent).not.toContain(CODE);
  });

  it("the 3rd wrong code stops the session; approve is never called", async () => {
    const port = fakeApprover();
    renderFlow(port);
    await toMatch(port);
    for (let i = 0; i < 3; i += 1) {
      typeCode("ffffffffffffffff");
      fireEvent.click(screen.getByTestId("pair-approve"));
    }
    expect(
      screen.getByText("Those codes don't match. Pairing stopped for safety. Start again."),
    ).toBeInTheDocument();
    expect(port.calls.some((c) => c.startsWith("approve"))).toBe(false);
    expect(port.calls).toContain("abandon");
  });
});

describe("A3 — confirm it's you (fresh unlock) and A4", () => {
  it("Style P: one passkey confirm, then 'Your phone is added as \"Phone\"'", async () => {
    const port = fakeApprover();
    renderFlow(port, "prf");
    await toMatch(port);
    typeCode(CODE);
    fireEvent.click(screen.getByTestId("pair-approve"));
    expect(screen.getByText("Confirm with your passkey to add this phone.")).toBeInTheDocument();
    expect(screen.queryByTestId("pair-passphrase")).toBeNull();
    fireEvent.click(screen.getByTestId("pair-confirm"));
    expect(await screen.findByTestId("pair-added")).toHaveTextContent(
      'Your phone is added as "Phone".',
    );
    expect(port.calls).toContain("approve:");
  });

  it("Style W: the passphrase box (not focused), then the passkey; a wrong one stays on A3", async () => {
    let first = true;
    const port = fakeApprover({
      approve: () => {
        if (first) {
          first = false;
          return Promise.reject(new WrongPassphraseError());
        }
        return Promise.resolve({ kind: "added", label: "Phone" });
      },
    });
    renderFlow(port, "passphrase");
    await toMatch(port);
    typeCode(CODE);
    fireEvent.click(screen.getByTestId("pair-approve"));
    const box = screen.getByTestId("pair-passphrase");
    expect(box).not.toHaveFocus(); // C10: a password manager fills it only on a tap
    fireEvent.change(box, { target: { value: "wrong7pass" } });
    fireEvent.click(screen.getByTestId("pair-confirm"));
    expect(await screen.findByText("That passphrase didn't match. Try again.")).toBeInTheDocument();
    expect(screen.getByTestId("pair-confirm")).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "blue7kites" } });
    fireEvent.click(screen.getByTestId("pair-confirm"));
    expect(await screen.findByTestId("pair-added")).toBeInTheDocument();
    expect(port.calls).toEqual(
      expect.arrayContaining(["approve:wrong7pass", "approve:blue7kites"]),
    );
  });

  it("no internet at grant time: 'Adding a device needs the internet'", async () => {
    const port = fakeApprover({ approve: () => Promise.resolve({ kind: "offline" }) });
    renderFlow(port);
    await toMatch(port);
    typeCode(CODE);
    fireEvent.click(screen.getByTestId("pair-approve"));
    fireEvent.click(screen.getByTestId("pair-confirm"));
    expect(
      await screen.findByText("Adding a device needs the internet. Connect, then start again."),
    ).toBeInTheDocument();
  });
});

describe("UX review fixes", () => {
  it("A1 on a phone says 'Add another device' and names the laptop's S0 button", async () => {
    const port = fakeApprover({ poll: { kind: "waiting" } });
    render(
      <AddDeviceFlow
        openApprover={() => port}
        tier="prf"
        online
        deviceWord="phone"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("add-mine"));
    expect(await screen.findByText("Add another device")).toBeInTheDocument();
    expect(screen.getByText('Tap "Add this laptop to my account".')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the other device…/)).toBeInTheDocument();
  });

  it("A1 on a laptop names the phone's S0 button", async () => {
    renderFlow(fakeApprover({ poll: { kind: "waiting" } }));
    fireEvent.click(screen.getByTestId("add-mine"));
    expect(await screen.findByText('Tap "Add this phone to my account".')).toBeInTheDocument();
  });

  it("an ended session shows its reason as the heading; Start again opens a new square code", async () => {
    const port = fakeApprover({ poll: { kind: "expired" } });
    renderFlow(port);
    fireEvent.click(screen.getByTestId("add-mine"));
    expect(await screen.findByTestId("pair-ended")).toHaveTextContent("Time ran out. Start again.");
    fireEvent.click(screen.getByTestId("pair-restart"));
    await waitFor(() => expect(port.calls.filter((c) => c === "open")).toHaveLength(2));
  });

  it("a session that ended after the unlock (A3) stops instead of asking to retry", async () => {
    const port = fakeApprover({
      approve: () => {
        (port as { over: boolean }).over = true;
        return Promise.reject(new Error("the master doc write failed"));
      },
    });
    renderFlow(port);
    await toMatch(port);
    typeCode(CODE);
    fireEvent.click(screen.getByTestId("pair-approve"));
    fireEvent.click(screen.getByTestId("pair-confirm"));
    expect(await screen.findByTestId("pair-ended")).toHaveTextContent(
      "Pairing interrupted. Start again.",
    );
  });
});

describe("leaving", () => {
  it("Cancel or unmount abandons the session (S, K and the request are dropped)", async () => {
    const port = fakeApprover({ poll: { kind: "waiting" } });
    const { onClose, unmount } = renderFlow(port);
    fireEvent.click(screen.getByTestId("add-mine"));
    await screen.findByTestId("pair-qr");
    fireEvent.click(screen.getByTestId("pair-cancel"));
    expect(onClose).toHaveBeenCalled();
    act(() => unmount());
    expect(port.calls).toContain("abandon");
  });

  it("autoStart (S6 'Add my phone now') opens the square code at once", async () => {
    const port = fakeApprover({ poll: { kind: "waiting" } });
    render(
      <AddDeviceFlow
        openApprover={() => port}
        tier="prf"
        online
        deviceWord="laptop"
        autoStart
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByTestId("pair-qr")).toBeInTheDocument();
    expect(port.calls[0]).toBe("open");
  });
});
