import { render } from "@testing-library/react";
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
    expect(getByTestId("unlock").textContent).toBe("Unlock with passkey");
    rerender(<LockScreen onUnlock={vi.fn()} busy={true} error={null} />);
    expect(getByTestId("unlock").textContent).toBe("Unlocking…");
  });
});
