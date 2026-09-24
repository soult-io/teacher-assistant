// J5 — New goal → mandatory baseline. No goal becomes monitorable without a baseline,
// and a proposed goal being baselined before its ARC is walled off from every
// downstream number: it never feeds Infinite Campus, never carries a weekly "owes", and
// is not even reachable as a dashboard row until the ARC adoption locks its baseline.
//
// The journey spans the two authored New-Goal paths, because the spec's assertions do:
//   • ADOPT — a baseline is already in hand, so the goal goes active immediately. This
//     is where the baseline-mandatory gate BLOCKS: Save is disabled until a baseline is
//     entered (blocked, not merely nagged). This path also carries the teacher-only
//     accom/mod detail we prove stays OUT of the draft IC statement.
//   • DRAFT — no baseline yet, so the goal is created `proposed` and routed to the
//     segregated Baseline track. This is where we prove the proposed goal is structurally
//     unreachable (no export control, no auto-statement, absent from the owes count), that
//     its baseline is an ESTIMATE usable only at ≥3 comparable points, that ARC date is
//     its own field, and that adoption is what finally makes the goal reachable.
//
// HONEST SCOPING (same discipline as J2/J4 — assert what is built, flag the rest):
//   • "Goals are not forced to percent" is asserted at the axis the New-Goal UI actually
//     exposes — the monitoring METHOD (CBM / Direct / Indirect / Authentic), a free
//     choice, not coerced to one default. The SCORING-MODEL axis (percent vs
//     rubric/count/duration, the DENOMINATOR_MODELS enum) is deliberately %-only in this
//     MVP UI (schema enums.ts: "MVP builds %-only UI; never %-coerce the others"), so a
//     non-% scoring goal cannot be authored yet — flagged in the PR, NOT faked here.
//   • "arc_date and iep_end_date are separate fields" is witnessed to the extent the DOM
//     can: the Baseline card exposes a dedicated, independently editable ARC-date control
//     and no coupled IEP-end control. That editing one never MOVES the other is proven
//     with real data in domain-core (arc-window.ts leaves iep_end_date untouched); the
//     e2e does not overclaim a data invariant the DOM cannot witness.
//
// The test.step titles and expect() messages are the journey card's step labels and
// assertions — written as human-readable evidence, verbatim.

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/journey";
import { goalRow, unlockToDashboard } from "./support/track";

/** Open the New-Goal form from the Weekly Dashboard. */
async function openNewGoal(page: Page): Promise<void> {
  await page.getByTestId("new-goal-cta").click();
  await expect(page.getByRole("heading", { name: "New goal" })).toBeVisible();
}

/** Fill the shared 6 KY IEP components + method + fixed 5-item probe basis. Leaves the
 *  path choice and the baseline to the caller (they differ per path). */
async function fillGoalCore(
  page: Page,
  opts: {
    readonly initials: string;
    readonly behavior: string;
    readonly circumstance: string;
    readonly accom: string;
    readonly accomDetail?: string;
  },
): Promise<void> {
  await page.getByTestId("ng-initials").fill(opts.initials);
  await page.getByTestId("ng-behavior").fill(opts.behavior);
  await page.getByTestId("ng-circumstance").fill(opts.circumstance);
  await page.getByTestId("ng-level").fill("80");
  await page.getByTestId("ng-consistency").fill("4");
  await page.getByTestId("ng-method-tool").fill("work sample");
  await page.getByTestId("ng-basis-fixed").click();
  await page.getByTestId("ng-total").fill("5");
  await page.getByTestId("ng-accom").selectOption(opts.accom);
  if (opts.accomDetail !== undefined) {
    await page.getByTestId("ng-accom-detail").fill(opts.accomDetail);
  }
}

test.describe("J5 — New goal → mandatory baseline", () => {
  test("ADOPT: baseline is truly mandatory (Save BLOCKED), method is a free choice, accom detail stays out of the IC statement", async ({
    page,
    step,
  }) => {
    await unlockToDashboard(page);

    const submit = page.getByTestId("ng-submit");
    const gate = page.getByTestId("ng-gate");
    // A goal distinct from every seeded goal, so its row/detail are unambiguous.
    const BEHAVIOR = "add integers on a number line";
    const ACCOM_DETAIL = "read-aloud plus extended time";

    await step(
      "Open New Goal and choose the ADOPT path (an already-baselined goal → active)",
      async () => {
        await openNewGoal(page);
        await page.getByTestId("ng-path-adopt").click();
      },
    );

    await step(
      "Fill the 6 KY IEP components, a fixed 5-item probe, and an Accommodation with a teacher-only detail",
      async () => {
        await fillGoalCore(page, {
          initials: "AB",
          behavior: BEHAVIOR,
          circumstance: "given a 5-item probe and a number line",
          accom: "accommodation",
          accomDetail: ACCOM_DETAIL,
        });
      },
    );

    await step(
      "The monitoring method is a free choice — the goal is authored as Authentic assessment, not coerced to one default",
      async () => {
        await page.getByTestId("ng-method-general").selectOption("authentic");
        await expect(
          page.getByTestId("ng-method-general"),
          "the method is honored as chosen (Authentic), never silently forced to a single default",
        ).toHaveValue("authentic");
      },
    );

    await step(
      "Baseline is MANDATORY — with every other field filled but no baseline, Save is BLOCKED (disabled), not merely nagged",
      async () => {
        await expect(
          gate,
          "the gate states the baseline-mandatory rule while the baseline is empty",
        ).toContainText("Baseline-mandatory");
        await expect(
          submit,
          "Save is disabled — the goal cannot be created until a baseline is entered",
        ).toBeDisabled();
        await expect(
          page.getByRole("heading", { name: "New goal" }),
          "the teacher is held on the New-Goal form; no goal was created",
        ).toBeVisible();
      },
    );

    await step("Enter the baseline — the gate clears and Save unblocks", async () => {
      await page.getByTestId("ng-baseline").fill("20");
      await expect(gate, "the gate now confirms the goal can go active and feed IC").toContainText(
        "can go active and feed IC",
      );
      await expect(submit, "Save is enabled only now the baseline is present").toBeEnabled();
    });

    await step("Save succeeds — the new goal appears active on the Weekly Dashboard", async () => {
      await submit.click();
      await expect(
        page.getByTestId("header-line"),
        "Save returns to the Weekly Dashboard",
      ).toBeVisible();
      await expect(
        goalRow(page, BEHAVIOR),
        "the newly created goal is a live dashboard row",
      ).toBeVisible();
    });

    await step(
      "The teacher-only accom/mod detail is kept OUT of the draft IC statement",
      async () => {
        await goalRow(page, BEHAVIOR)
          .getByRole("button", { name: /trend and history/ })
          .click();
        const statement = page.getByTestId("auto-statement");
        await expect(
          statement,
          "an active, baselined goal has a draft IC statement (it is IC-exportable)",
        ).toBeVisible();
        await expect(
          page.getByTestId("statement-variant"),
          "on a brand-new goal with no monitoring points the statement is INDETERMINATE — it claims no trend",
        ).toContainText("Indeterminate");
        await expect(
          statement,
          "the free-form accom/mod detail is absent from the draft IC statement — it is a teacher-only reference the statement engine never reads",
        ).not.toContainText(ACCOM_DETAIL);
      },
    );
  });

  test("DRAFT: a proposed goal is unreachable by IC export & owes; its baseline is an ESTIMATE at ≥3 points; adoption makes it reachable", async ({
    page,
    step,
  }) => {
    await unlockToDashboard(page);

    const oweCount = page.getByTestId("owe-count");
    const BEHAVIOR = "count coins to one dollar";
    let oweBefore = "";

    await step(
      "Note the current owe-count, then draft a proposed goal (no baseline entered)",
      async () => {
        oweBefore = (await oweCount.textContent())?.trim() ?? "";
        await openNewGoal(page);
        await page.getByTestId("ng-path-draft").click();
        await fillGoalCore(page, {
          initials: "ZZ",
          behavior: BEHAVIOR,
          circumstance: "given a 5-item probe",
          accom: "none",
        });
      },
    );

    await step(
      "On the DRAFT path a baseline is NOT required to save — it is gathered later in the Baseline track",
      async () => {
        await expect(
          page.getByTestId("ng-submit"),
          "a draft (proposed) goal saves without a baseline; the mandatory gate is the ADOPT-path rule",
        ).toBeEnabled();
        await page.getByTestId("ng-submit").click();
        await expect(
          page.getByRole("heading", { name: "Baseline / proposed goals" }),
          "saving a draft routes to the segregated Baseline / proposed-goal track",
        ).toBeVisible();
      },
    );

    const card = page.getByTestId("proposed-card").filter({ hasText: BEHAVIOR });

    await step(
      "The proposed goal is STRUCTURALLY unreachable by IC — no export control and no auto-statement exist for it",
      async () => {
        await expect(card, "the drafted goal appears as a proposed/baseline card").toBeVisible();
        await expect(
          card.getByTestId("auto-statement"),
          "a proposed goal produces NO draft IC statement",
        ).toHaveCount(0);
        await expect(
          card.getByTestId("copy-to-ic"),
          "a proposed goal has NO copy-to-IC control",
        ).toHaveCount(0);
        await expect(
          card.getByTestId("copy-quarterly"),
          "a proposed goal has NO IC quarterly-copy control",
        ).toHaveCount(0);
      },
    );

    await step(
      "The proposed goal is ABSENT from the active dashboard — not a row, not counted in owes",
      async () => {
        await page.locator("button.back").first().click();
        await expect(page.getByTestId("header-line"), "back on the Weekly Dashboard").toBeVisible();
        await expect(
          oweCount,
          "drafting a proposed goal did not change the weekly owe-count — proposed goals carry no owes",
        ).toHaveText(oweBefore);
        await expect(
          goalRow(page, BEHAVIOR),
          "the proposed goal is not present on the active weekly dashboard",
        ).toHaveCount(0);
        await page.getByTestId("baseline-track").click();
        await expect(
          page.getByRole("heading", { name: "Baseline / proposed goals" }),
        ).toBeVisible();
      },
    );

    await step(
      "Baseline is usable only at ≥3 comparable points — below that it is explicitly NOT usable",
      async () => {
        await expect(
          card.getByTestId("baseline-not-usable"),
          "with no points the card asks for more comparable probes, not a usable baseline",
        ).toBeVisible();
        await addBaselinePoint(card, 3);
        await addBaselinePoint(card, 3);
        await expect(
          card.getByTestId("baseline-not-usable"),
          "at 2 comparable points the baseline is still not usable (needs ≥3)",
        ).toContainText("more comparable probe");
        await expect(
          card.getByTestId("baseline-estimate"),
          "no usable estimate is shown before the third comparable point",
        ).toHaveCount(0);
      },
    );

    await step(
      "At the third comparable point the baseline becomes a usable ESTIMATE (an average, never a trend)",
      async () => {
        await addBaselinePoint(card, 3);
        const estimate = card.getByTestId("baseline-estimate");
        await expect(
          estimate,
          "a usable baseline estimate appears at 3 comparable points",
        ).toBeVisible();
        await expect(
          estimate,
          "the baseline is labeled an ESTIMATE (average), not a monitoring trend value",
        ).toContainText("baseline estimate");
        await expect(
          card.getByText("An ESTIMATE, not a trend"),
          "the estimate is explicitly framed as an estimate that only locks in on ARC adoption",
        ).toBeVisible();
      },
    );

    await step(
      "ARC date is its own field — editing it moves the baseline window, and no IEP-end control is coupled to it",
      async () => {
        await card.getByLabel("arc date").fill("2026-06-19");
        await expect(
          card,
          "editing the ARC date sets the baseline window's ARC deadline — arc_date is an independently editable field",
        ).toContainText("closes ARC 2026-06-19");
        await expect(
          card.locator('input[type="date"]'),
          "the card exposes exactly one date control (ARC) — the IEP-end date is a separate field, not this one",
        ).toHaveCount(1);
      },
    );

    await step(
      "Adoption at ARC is what finally makes the goal reachable — it becomes a live, IC-exportable dashboard goal",
      async () => {
        await card.getByTestId("adopt-button").click();
        await expect(
          page.getByTestId("header-line"),
          "adoption returns to the Weekly Dashboard",
        ).toBeVisible();
        await expect(
          goalRow(page, BEHAVIOR),
          "only after ARC adoption does the goal appear as an active dashboard row",
        ).toBeVisible();
        await goalRow(page, BEHAVIOR)
          .getByRole("button", { name: /trend and history/ })
          .click();
        await expect(
          page.getByTestId("copy-to-ic"),
          "the adopted goal is now IC-exportable — the copy-to-IC path that never existed while proposed is present",
        ).toBeVisible();
      },
    );
  });
});

/** Add one comparable baseline point of `correct` out of the default 5-item probe, from
 *  the proposed card's inline add-point row. Each point shares the goal's probe condition,
 *  so all three are comparable. */
async function addBaselinePoint(card: Locator, correct: number): Promise<void> {
  await card.getByLabel("baseline correct").fill(String(correct));
  await card.getByRole("button", { name: "+ Add baseline point" }).click();
}
