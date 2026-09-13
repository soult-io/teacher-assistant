import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { BootstrapOptions, Session } from "./data/session.js";
import { buildSyntheticSeed } from "./data/synthetic-seed.js";

// A crypto-free bootstrap: the real unlock/crypto path is covered by
// session.test.ts (node env); here we test the UI wiring (locked → click →
// live dashboard) without libsodium, which cannot run under jsdom's realm.
// It honours the `now` the app pins, so the seed's week matches the dashboard's
// evaluation week (both = the app's `new Date()`), giving a deterministic header.
function fakeBootstrap(options: BootstrapOptions): Promise<Session> {
  return Promise.resolve({
    role: "teacher",
    records: buildSyntheticSeed(options.now),
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
    expect(header).toHaveTextContent("2 of 4 collectable scored · 1 excused · 2 owe");
  });
});
