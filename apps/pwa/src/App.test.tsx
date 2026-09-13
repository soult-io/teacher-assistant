import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { BootstrapOptions } from "./data/session.js";
import { buildSyntheticSeed } from "./data/synthetic-seed.js";
import { makeFakeSession } from "./test/fake-session.js";

// A crypto-free bootstrap that still exercises the real write path (M5 mutators
// over a Yjs doc). The seed uses the app's pinned `now`, so its week matches the
// dashboard's evaluation week.
function bootstrap(options: BootstrapOptions) {
  return Promise.resolve(makeFakeSession(buildSyntheticSeed(options.now)));
}

async function unlock() {
  render(<App bootstrap={bootstrap} />);
  fireEvent.click(screen.getByTestId("unlock"));
  await screen.findByTestId("header-line");
}

describe("App — unlock, live dashboard, and M5 writes", () => {
  it("opens locked with the app heading", () => {
    render(<App bootstrap={bootstrap} />);
    expect(screen.getByRole("heading", { name: "Teacher Assistant" })).toBeVisible();
    expect(screen.getByTestId("unlock")).toBeInTheDocument();
  });

  it("renders the live dashboard header after unlock", async () => {
    await unlock();
    expect(screen.getByTestId("header-line")).toHaveTextContent(
      "2 of 4 collectable scored · 1 excused · 2 owe",
    );
  });

  it("scores an owes goal through the Quick-Score sheet, updating the header", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "score Multiply fractions" }));
    // Bump #correct to 4 of 5 (80%) then save.
    const plus = screen.getByRole("button", { name: "plus" });
    for (let i = 0; i < 4; i++) {
      fireEvent.click(plus);
    }
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // scored 2 → 3, owe 2 → 1.
    const header = await screen.findByTestId("header-line");
    expect(header).toHaveTextContent("3 of 4 collectable scored · 1 excused · 1 owe");
  });

  it("gates Save behind the F-2 mismatch acknowledgment on a genuine mismatch", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "score Multiply fractions" }));
    // Change the total from the assigned 5 to 6 → a genuine denominator mismatch.
    fireEvent.change(screen.getByLabelText("total items"), { target: { value: "6" } });

    // Save is gated: the ack replaces the plain Save with the two dispositions.
    expect(screen.getByTestId("mismatch-ack")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    // One tap picks the disposition (and acknowledges) → the point saves.
    fireEvent.click(screen.getByRole("button", { name: "Count it in the trend" }));
    const header = await screen.findByTestId("header-line");
    expect(header).toHaveTextContent("3 of 4 collectable scored");
  });

  it("records a no-data ⊘ with a required reason", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "score Multiply fractions" }));
    fireEvent.click(screen.getByRole("button", { name: "No data" }));
    // Record is disabled until a reason is chosen.
    const record = screen.getByRole("button", { name: "Record no data" });
    expect(record).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Absent" }));
    expect(record).toBeEnabled();
    fireEvent.click(record);

    // The excused ⊘ raises the excused count (2) and drops owe to 1.
    const header = await screen.findByTestId("header-line");
    expect(header).toHaveTextContent("2 of 3 collectable scored · 2 excused · 1 owe");
  });

  it("tapping an owes row that already has a ⚑ bookmark completes it in place (no duplicate)", async () => {
    await unlock();
    const flags = screen.getAllByRole("button", { name: "Gave it, score later" });
    const flag = flags[0];
    if (flag === undefined) {
      throw new Error("expected a score-later button");
    }
    fireEvent.click(flag); // bookmark AB Two-step equations
    expect(await screen.findByTestId("to-score")).toHaveTextContent("To-score (1)");

    // Tap the same row to score it directly → completes the queued point in place.
    fireEvent.click(screen.getByRole("button", { name: "score Two-step equations" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Exactly one scored point results: the queue empties (not left stranded) and
    // the scored count rises by one.
    expect(await screen.findByTestId("to-score")).toHaveTextContent("To-score (0)");
    expect(screen.getByTestId("header-line")).toHaveTextContent("3 of 4 collectable scored");
  });

  it("opens Goal Detail from a row's ↗ and returns to the dashboard", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "trend and history Add integers" }));
    // The detail screen renders the DRAFT statement + trend chart.
    expect(await screen.findByText(/Draft progress statement/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "progress trend" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "‹ Dashboard" }));
    expect(await screen.findByTestId("header-line")).toBeInTheDocument();
  });

  it("acknowledging mastery writes a durable ARC flag (goal stays open)", async () => {
    await unlock();
    // "Multiply fractions" has a met consistency window → the Acknowledge action.
    fireEvent.click(screen.getByRole("button", { name: "trend and history Multiply fractions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Acknowledge for ARC" }));
    // The write→re-render loop shows the durable acknowledged banner; the goal is
    // NOT auto-closed (still reachable, still on the board on return).
    expect(await screen.findByTestId("mastery-acknowledged")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "‹ Dashboard" }));
    expect(await screen.findByTestId("header-line")).toBeInTheDocument();
  });

  it("⚑ bookmarks to the To-Score queue and scoring there clears it", async () => {
    await unlock();
    const flags = screen.getAllByRole("button", { name: "Gave it, score later" });
    const flag = flags[0];
    if (flag === undefined) {
      throw new Error("expected a score-later button");
    }
    fireEvent.click(flag);

    // The queue count rises to 1.
    const toScore = await screen.findByTestId("to-score");
    expect(toScore).toHaveTextContent("To-score (1)");

    fireEvent.click(toScore);
    fireEvent.click(await screen.findByRole("button", { name: /full editor/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Queued point scored → the queue is empty.
    expect(await screen.findByTestId("queue-empty")).toBeInTheDocument();
  });
});
