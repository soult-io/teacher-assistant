import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import { buildSyntheticSeed } from "./data/synthetic-seed.js";
import type { Session } from "./data/session.js";

const NOW = new Date("2026-09-14T12:00:00Z");

// A crypto-free bootstrap: the real unlock/crypto path is covered by
// session.test.ts (node env); here we test the UI wiring (locked → click →
// live dashboard) without libsodium, which cannot run under jsdom's realm.
function fakeBootstrap(): Promise<Session> {
  return Promise.resolve({
    role: "teacher",
    records: buildSyntheticSeed(NOW),
    sync: () => Promise.resolve(false),
  });
}

describe("App — unlock → live dashboard", () => {
  it("opens locked with the app heading", () => {
    render(<App bootstrap={fakeBootstrap} />);
    expect(screen.getByRole("heading", { name: "Teacher Assistant" })).toBeVisible();
    expect(screen.getByTestId("unlock")).toBeInTheDocument();
  });

  it("renders the live dashboard header after a passkey unlock", async () => {
    render(<App bootstrap={fakeBootstrap} />);
    screen.getByTestId("unlock").click();

    const header = await screen.findByTestId("header-line");
    expect(header).toHaveTextContent(/scored · .* excused · .* owe/);
  });
});
