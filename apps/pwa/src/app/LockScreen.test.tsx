import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LockScreen } from "./LockScreen.js";

describe("LockScreen", () => {
  it("caps its content in a centered .lockbody column so the wide button never runs edge-to-edge on desktop", () => {
    // The lock screen renders as the plain `.phone` (no 1180 shell), so on a wide monitor
    // the `.btn.wide` (width:100%) stretched full-viewport. The fix wraps icon/title/note/
    // button in a single capped, centered `.lockbody` column (the desktop-margin-polish fix).
    const { container } = render(<LockScreen onUnlock={vi.fn()} busy={false} error={null} />);
    const body = container.querySelector(".lock > .lockbody");
    expect(body).not.toBeNull();
    // The wide unlock button and the heading live inside the capped column.
    expect(body?.querySelector('[data-testid="unlock"]')).not.toBeNull();
    expect(body?.querySelector("h1")?.textContent).toBe("Teacher Assistant");
    // The button is not a direct child of `.lock` (which is full-viewport on desktop).
    expect(container.querySelector('.lock > [data-testid="unlock"]')).toBeNull();
  });

  it("keeps the unlock button testid and busy label", () => {
    const { getByTestId, rerender } = render(
      <LockScreen onUnlock={vi.fn()} busy={false} error={null} />,
    );
    expect(getByTestId("unlock").textContent).toBe("Unlock with your passkey");
    rerender(<LockScreen onUnlock={vi.fn()} busy={true} error={null} />);
    expect(getByTestId("unlock").textContent).toBe("Unlocking…");
  });

  it("Style P (U1): no passphrase box; unlock passes no passphrase", () => {
    const onUnlock = vi.fn();
    const { getByTestId, queryByTestId } = render(
      <LockScreen onUnlock={onUnlock} busy={false} error={null} tier="prf" />,
    );
    expect(queryByTestId("unlock-passphrase")).toBeNull();
    fireEvent.click(getByTestId("unlock"));
    expect(onUnlock).toHaveBeenCalledWith(undefined);
  });

  it("Style W (U2): the passphrase box is NOT focused on load (C10), and unlock passes it", () => {
    const onUnlock = vi.fn();
    const { getByTestId } = render(
      <LockScreen onUnlock={onUnlock} busy={false} error={null} tier="passphrase" />,
    );
    const box = getByTestId("unlock-passphrase");
    expect(document.activeElement).not.toBe(box);
    expect(box).not.toHaveAttribute("autofocus");
    expect(box).toHaveAttribute("autocomplete", "current-password");
    fireEvent.change(box, { target: { value: "blue7kites" } });
    fireEvent.click(getByTestId("unlock"));
    expect(onUnlock).toHaveBeenCalledWith("blue7kites");
  });

  it("Style W: Enter in the passphrase box starts the unlock", () => {
    const onUnlock = vi.fn();
    const { getByTestId } = render(
      <LockScreen onUnlock={onUnlock} busy={false} error={null} tier="passphrase" />,
    );
    const box = getByTestId("unlock-passphrase");
    fireEvent.change(box, { target: { value: "blue7kites" } });
    fireEvent.submit(box);
    expect(onUnlock).toHaveBeenCalledWith("blue7kites");
  });
});
