import { RelayRequestError } from "@teacher-assistant/sync";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { BootstrapOptions } from "./data/session.js";
import { buildSyntheticSeed } from "./data/synthetic-seed.js";
import { makeFakeParaSession, makeFakeSession } from "./test/fake-session.js";

// A crypto-free two-doc device that still exercises the real write path (the M5/M13
// mutators + the two-doc validate coordinator over Yjs docs). The seed uses the app's
// pinned `now`, so its week matches the dashboard's evaluation week.
function bootstrap(options: BootstrapOptions) {
  return Promise.resolve(makeFakeSession(buildSyntheticSeed(options.now)));
}

// A write settles asynchronously: the real session awaits crypto + IndexedDB, and the
// fake settles a timer tick later. The element being asserted on is often already
// rendered with its PRE-write text, so `await findByTestId(...)` resolves at once and
// a one-shot text check races the write (TEACH-63). Wait for the post-write text.
async function expectTextAfterWrite(testId: string, text: string) {
  await waitFor(() => expect(screen.getByTestId(testId)).toHaveTextContent(text));
}

async function unlock() {
  render(<App bootstrap={bootstrap} bootstrapPara={makeFakeParaSession} />);
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
    fireEvent.click(screen.getByRole("button", { name: "score Goal 2, Multiply fractions" }));
    // Bump #correct to 4 of 5 (80%) then save.
    const plus = screen.getByRole("button", { name: "plus" });
    for (let i = 0; i < 4; i++) {
      fireEvent.click(plus);
    }
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // scored 2 → 3, owe 2 → 1.
    await expectTextAfterWrite("header-line", "3 of 4 collectable scored · 1 excused · 1 owe");
  });

  it("gates Save behind the F-2 mismatch acknowledgment on a genuine mismatch", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "score Goal 2, Multiply fractions" }));
    // Change the total from the assigned 5 to 6 → a genuine denominator mismatch.
    fireEvent.change(screen.getByLabelText("total items"), { target: { value: "6" } });

    // Save is gated: the ack replaces the plain Save with the two dispositions.
    expect(screen.getByTestId("mismatch-ack")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    // One tap picks the disposition (and acknowledges) → the point saves.
    fireEvent.click(screen.getByRole("button", { name: "Count it in the trend" }));
    await expectTextAfterWrite("header-line", "3 of 4 collectable scored");
  });

  it("records a no-data ⊘ with a required reason", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "score Goal 2, Multiply fractions" }));
    fireEvent.click(screen.getByRole("button", { name: "No data" }));
    // Record is disabled until a reason is chosen.
    const record = screen.getByRole("button", { name: "Record no data" });
    expect(record).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Absent" }));
    expect(record).toBeEnabled();
    fireEvent.click(record);

    // The excused ⊘ raises the excused count (2) and drops owe to 1.
    await expectTextAfterWrite("header-line", "2 of 3 collectable scored · 2 excused · 1 owe");
  });

  it("tapping an owes row that already has a 🕐 score-later bookmark completes it in place (no duplicate)", async () => {
    await unlock();
    const toggles = screen.getAllByRole("button", { name: "Collected — score later" });
    const toggle = toggles[0];
    if (toggle === undefined) {
      throw new Error("expected a score-later button");
    }
    fireEvent.click(toggle); // bookmark AB Two-step equations
    await expectTextAfterWrite("to-score", "To-score (1)");

    // Tap the same row to score it directly → completes the queued point in place.
    fireEvent.click(screen.getByRole("button", { name: "score Goal 1, Two-step equations" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Exactly one scored point results: the queue empties (not left stranded) and
    // the scored count rises by one.
    await expectTextAfterWrite("to-score", "To-score (0)");
    expect(screen.getByTestId("header-line")).toHaveTextContent("3 of 4 collectable scored");
  });

  it("opens Goal Detail from a row's ↗ and returns to the dashboard", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "trend and history Goal 2, Add integers" }));
    // The detail screen renders the DRAFT statement + trend chart.
    expect(await screen.findByText(/Draft progress statement/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "progress trend" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "‹ Dashboard" }));
    expect(await screen.findByTestId("header-line")).toBeInTheDocument();
  });

  it("acknowledging mastery writes a durable ARC flag (goal stays open)", async () => {
    await unlock();
    // "Multiply fractions" has a met consistency window → the Acknowledge action.
    fireEvent.click(
      screen.getByRole("button", { name: "trend and history Goal 2, Multiply fractions" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Acknowledge for ARC" }));
    // The write→re-render loop shows the durable acknowledged banner; the goal is
    // NOT auto-closed (still reachable, still on the board on return).
    expect(await screen.findByTestId("mastery-acknowledged")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "‹ Dashboard" }));
    expect(await screen.findByTestId("header-line")).toBeInTheDocument();
  });

  it("🕐 score-later bookmarks to the To-Score queue and scoring there clears it", async () => {
    await unlock();
    const toggles = screen.getAllByRole("button", { name: "Collected — score later" });
    const toggle = toggles[0];
    if (toggle === undefined) {
      throw new Error("expected a score-later button");
    }
    fireEvent.click(toggle);

    // The queue count rises to 1.
    await expectTextAfterWrite("to-score", "To-score (1)");

    fireEvent.click(screen.getByTestId("to-score"));
    fireEvent.click(await screen.findByRole("button", { name: /full editor/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Queued point scored → the queue is empty.
    expect(await screen.findByTestId("queue-empty")).toBeInTheDocument();
  });

  it("drafts a proposed goal that lands on the baseline track and never on the active dashboard", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "+ New goal" }));
    fireEvent.click(screen.getByRole("button", { name: /Draft a proposed goal/ }));
    fireEvent.change(screen.getByPlaceholderText("e.g. AB or JAS"), { target: { value: "ZZ" } });
    fireEvent.change(screen.getByPlaceholderText("solve two-step equations"), {
      target: { value: "count coins to a dollar" },
    });
    fireEvent.change(screen.getByPlaceholderText("given a 5-item probe and a number line"), {
      target: { value: "given a 5-item probe" },
    });
    fireEvent.change(screen.getByLabelText("criterion level"), { target: { value: "80" } });
    fireEvent.change(screen.getByLabelText("criterion consistency"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("method tool"), { target: { value: "coin probe" } });
    fireEvent.click(screen.getByRole("button", { name: "Start baselining →" }));

    // Lands on the segregated baseline/proposed track, showing the new proposed goal.
    expect(await screen.findByText("Baseline / proposed goals")).toBeInTheDocument();
    expect((await screen.findAllByText(/count coins to a dollar/)).length).toBeGreaterThan(0);

    // Back on the active dashboard, the proposed goal is NOT a row (never mixed in).
    fireEvent.click(screen.getByRole("button", { name: "‹ Dashboard" }));
    const body = (await screen.findByTestId("dashboard-body")).textContent ?? "";
    expect(body).not.toContain("count coins to a dollar");
  });

  it("normalizes dotted 3-letter initials end to end (TEACH-40)", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "+ New goal" }));
    fireEvent.click(screen.getByRole("button", { name: /Draft a proposed goal/ }));
    // Synthetic initials — a middle initial disambiguates two students (TEACH-26).
    fireEvent.change(screen.getByPlaceholderText("e.g. AB or JAS"), {
      target: { value: "z.q.z." },
    });
    fireEvent.change(screen.getByPlaceholderText("solve two-step equations"), {
      target: { value: "skip count by fives" },
    });
    fireEvent.change(screen.getByPlaceholderText("given a 5-item probe and a number line"), {
      target: { value: "given a 5-item probe" },
    });
    fireEvent.change(screen.getByLabelText("criterion level"), { target: { value: "80" } });
    fireEvent.change(screen.getByLabelText("criterion consistency"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("method tool"), { target: { value: "count probe" } });
    fireEvent.click(screen.getByRole("button", { name: "Start baselining →" }));

    expect(await screen.findByText("Baseline / proposed goals")).toBeInTheDocument();
    expect((await screen.findAllByRole("img", { name: "student ZQZ" })).length).toBeGreaterThan(0);
    expect(screen.queryByText(/z\.q\.z\./i)).toBeNull();
  });

  it("the IEP goal # duplicate warning matches dotted initials to the roster student (TEACH-40 + TEACH-41)", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "+ New goal" }));
    // ADOPT is the default path; the seed's AB already has an active Goal 2.
    fireEvent.change(screen.getByPlaceholderText("e.g. AB or JAS"), { target: { value: "a.b." } });
    fireEvent.change(screen.getByTestId("ng-goal-label"), { target: { value: "2" } });
    expect(screen.getByTestId("ng-goal-label-dup")).toHaveTextContent(/^AB already has Goal 2/);
  });

  it("a VARIABLE-basis goal accepts any total with NO off-basis ack (F-2 escape valve)", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "+ New goal" }));
    // ADOPT is the default path.
    fireEvent.change(screen.getByPlaceholderText("e.g. AB or JAS"), { target: { value: "AB" } });
    fireEvent.change(screen.getByPlaceholderText("solve two-step equations"), {
      target: { value: "read sight words" },
    });
    fireEvent.change(screen.getByPlaceholderText("given a 5-item probe and a number line"), {
      target: { value: "given a word list" },
    });
    fireEvent.change(screen.getByLabelText("criterion level"), { target: { value: "80" } });
    fireEvent.change(screen.getByLabelText("criterion consistency"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("method tool"), { target: { value: "word list" } });
    fireEvent.click(screen.getByRole("button", { name: "Variable / custom" }));
    fireEvent.change(screen.getByLabelText("baseline percent"), { target: { value: "30" } });
    fireEvent.change(screen.getByTestId("ng-goal-label"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Activate goal · begin monitoring" }));

    // The new active goal is on the dashboard; open its score sheet.
    fireEvent.click(await screen.findByRole("button", { name: /score .*read sight words/ }));
    // Enter an off-basis total (7 ≠ the suggested 5) — a FIXED goal would gate Save
    // behind the F-2 ack, but a variable-basis goal must not.
    fireEvent.change(screen.getByLabelText("total items"), { target: { value: "7" } });
    expect(screen.queryByTestId("mismatch-ack")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("editing a goal's IEP # on Goal Detail persists it and the duplicate cue shows on BOTH rows (TEACH-41)", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "trend and history Goal 2, Add integers" }));
    fireEvent.click(screen.getByTestId("goal-label-edit"));
    const input = screen.getByTestId("goal-label-input");
    fireEvent.change(input, { target: { value: "1" } }); // AB now has two Goal 1
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByTestId("detail-dup-warning")).toHaveTextContent(
      "AB has two Goal 1 — Add integers and Two-step equations",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Goal 1/);
    fireEvent.click(screen.getByRole("button", { name: "‹ Dashboard" }));
    // The lasting cue: both of AB's Goal 1 rows carry it on the dashboard.
    const cues = await screen.findAllByTestId("dup-label-cue");
    expect(cues.length).toBe(2);
    // Fixing one label clears the cue everywhere.
    fireEvent.click(screen.getByRole("button", { name: "trend and history Goal 1, Add integers" }));
    fireEvent.click(screen.getByTestId("goal-label-edit"));
    fireEvent.change(screen.getByTestId("goal-label-input"), { target: { value: "2" } });
    fireEvent.keyDown(screen.getByTestId("goal-label-input"), { key: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("detail-dup-warning")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "‹ Dashboard" }));
    expect(screen.queryAllByTestId("dup-label-cue")).toHaveLength(0);
  });

  it("TEACH-46: a typed 0 is saved, then removed with a reason — kept in History, out of the count", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "Baseline / proposed goals" }));
    await screen.findByText("Baseline / proposed goals", { selector: "h1" });
    fireEvent.change(screen.getByLabelText("baseline correct"), { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("add-baseline-point"));
    await waitFor(() => expect(screen.getAllByTestId("baseline-point")).toHaveLength(4));
    const zero = screen.getAllByRole("button", { name: /^remove baseline point .* 0\/5$/ });
    fireEvent.click(zero[0] as HTMLElement);
    fireEvent.click(screen.getByRole("radio", { name: "Entered by mistake" }));
    fireEvent.click(screen.getByTestId("confirm-remove"));
    await waitFor(() => expect(screen.getAllByTestId("baseline-point")).toHaveLength(3));
    expect(screen.getByTestId("baseline-history")).toHaveTextContent(
      /Removed \d{4}-\d{2}-\d{2}: Entered by mistake \(was 0\/5\)/,
    );
    expect(screen.getByTestId("baseline-estimate")).toHaveTextContent("33%");
  });

  it("TEACH-46 E10: the para surface has no baseline Fix or Remove", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "Para (JT)" }));
    expect(await screen.findByText("Your students today")).toBeInTheDocument();
    expect(screen.queryByTestId("baseline-points")).toBeNull();
    expect(screen.queryByRole("button", { name: /baseline point/ })).toBeNull();
    expect(screen.queryByText(/Baseline \/ proposed/)).toBeNull();
  });

  it("switching to the Para role shows the period-scoped para surface", async () => {
    await unlock();
    fireEvent.click(screen.getByRole("button", { name: "Para (JT)" }));
    expect(await screen.findByText("Your students today")).toBeInTheDocument();
    // A para capture opens the hard-constrained sheet (no free-text).
    fireEvent.click(screen.getAllByRole("button", { name: /^score / })[0] as HTMLElement);
    expect(await screen.findByRole("dialog", { name: "para score entry" })).toBeInTheDocument();
  });

  it("teacher validates a pending para point from the queue (nothing counts until then)", async () => {
    await unlock();
    fireEvent.click(screen.getByTestId("validate-note"));
    const confirms = await screen.findAllByRole("button", { name: /^confirm / });
    expect(confirms.length).toBe(2); // two seeded para captures await validation
    fireEvent.click(confirms[0] as HTMLElement);
    // One validated → it leaves the queue; one remains.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^confirm / }).length).toBe(1),
    );
  });
});

/** Force the desktop breakpoint (jsdom has no matchMedia, so it defaults to mobile). */
function stubDesktop() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: true,
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

function groupBy(label: string) {
  const toggle = screen.getByTestId("group-toggle");
  for (let i = 0; i < 3 && !(toggle.textContent ?? "").includes(label); i++) {
    fireEvent.click(toggle);
  }
  expect(toggle).toHaveTextContent(`Group: ${label}`);
}

describe("App — the dashboard grouping survives Goal Detail and tab switches (TEACH-43)", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  it.each([
    ["mobile", () => {}],
    ["desktop", stubDesktop],
  ])("%s: by period → ↗ → Back is still 'Group: by period'", async (_layout, setup) => {
    setup();
    await unlock();
    expect(screen.getByTestId("group-toggle")).toHaveTextContent("Group: owes-first");
    groupBy("by period");
    fireEvent.click(screen.getByRole("button", { name: "trend and history Goal 2, Add integers" }));
    expect(await screen.findByRole("img", { name: "progress trend" })).toBeInTheDocument();
    // Desktop shows the top-bar back and the (CSS-hidden) in-screen one; either returns.
    fireEvent.click(screen.getAllByRole("button", { name: "‹ Dashboard" })[0] as HTMLElement);
    expect(await screen.findByTestId("group-toggle")).toHaveTextContent("Group: by period");
  });

  it("keeps the grouping across a Plan → Track tab switch", async () => {
    await unlock();
    groupBy("by student");
    fireEvent.click(screen.getAllByRole("button", { name: /Plan/ })[0] as HTMLElement);
    expect(screen.queryByTestId("group-toggle")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /Track/ })[0] as HTMLElement);
    expect(await screen.findByTestId("group-toggle")).toHaveTextContent("Group: by student");
  });

  it("starts on owes-first after a fresh unlock", async () => {
    await unlock();
    groupBy("by period");
    cleanup();
    await unlock();
    expect(screen.getByTestId("group-toggle")).toHaveTextContent("Group: owes-first");
  });
});

describe("App — unlock error copy is passkey-only; the relay never blocks unlock", () => {
  const NOW = new Date("2026-09-14T12:00:00Z");

  it("shows the passkey guidance ONLY for a genuine keyring/passkey/decryption failure", async () => {
    render(
      <App
        bootstrap={() => Promise.reject(new Error("keyring unwrap failed"))}
        bootstrapPara={makeFakeParaSession}
      />,
    );
    fireEvent.click(screen.getByTestId("unlock"));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveTextContent("Check your passkey"));
    expect(screen.getByTestId("unlock")).toBeInTheDocument(); // stays locked
  });

  it("does NOT blame the passkey when unlock fails for a relay/sync reason", async () => {
    render(
      <App
        bootstrap={() => Promise.reject(new RelayRequestError(404, "doc-1", null))}
        bootstrapPara={makeFakeParaSession}
      />,
    );
    fireEvent.click(screen.getByTestId("unlock"));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.textContent ?? "").not.toBe(""));
    expect(alert).not.toHaveTextContent("Check your passkey");
  });

  it("reaches the ready dashboard even when the post-unlock reconcile rejects (non-blocking)", async () => {
    const base = makeFakeSession(buildSyntheticSeed(NOW));
    // A session whose best-effort reconcile REJECTS (a contract violation the app must
    // still survive): unlock has already opened the local store — it must reach ready
    // and never surface the failure.
    const flaky = { ...base, sync: () => Promise.reject(new Error("relay down")) };
    render(<App bootstrap={() => Promise.resolve(flaky)} bootstrapPara={makeFakeParaSession} />);
    fireEvent.click(screen.getByTestId("unlock"));
    expect(await screen.findByTestId("header-line")).toBeInTheDocument();
    expect(screen.queryByText(/Check your passkey/)).toBeNull();
  });
});
