// @teacher-assistant/store — M3 local store / repository + projections.
//
// Pure view-model builders over already-decrypted records. A proposed/baseline
// goal never reaches the active weekly dashboard (asserted by the FERPA-guard
// suite). The full TRACK UI that consumes these is Phase 1.

export {
  type DashboardState,
  type DashboardRow,
  type DashboardHeader,
  type WeeklyDashboard,
  type WeeklyDashboardInput,
  buildWeeklyDashboard,
  renderHeader,
  type DashboardLens,
  nextLens,
  type DashboardGroup,
  groupDashboard,
  type BaselineViewRow,
  buildBaselineView,
  type QueueEntry,
  buildToScoreQueue,
  buildValidationQueue,
} from "./projections.js";
