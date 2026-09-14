import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsDesktop } from "./useIsDesktop.js";

function Probe() {
  return <span data-testid="v">{useIsDesktop() ? "desktop" : "mobile"}</span>;
}

function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("useIsDesktop", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("reports MOBILE when matchMedia is absent (jsdom default) — the validated layout", () => {
    render(<Probe />);
    expect(screen.getByTestId("v")).toHaveTextContent("mobile");
  });

  it("reports desktop when the min-width query matches", () => {
    stubMatchMedia(true);
    render(<Probe />);
    expect(screen.getByTestId("v")).toHaveTextContent("desktop");
  });

  it("reports mobile when the query does not match", () => {
    stubMatchMedia(false);
    render(<Probe />);
    expect(screen.getByTestId("v")).toHaveTextContent("mobile");
  });
});
