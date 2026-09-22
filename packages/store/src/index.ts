// @teacher-assistant/store — M3 local store / repository + projections, and the
// M10 material library store.
//
// Pure view-model builders over already-decrypted records. A proposed/baseline
// goal never reaches the active weekly dashboard (asserted by the FERPA-guard
// suite). The full TRACK UI that consumes these is Phase 1.

// M10-U2 — the material library store: encrypted CRUD (create/edit/retag/retire)
// over the teacher's private differentiation library, ciphertext at rest under
// the teacher master key. The pure library-list projection lives in domain-core.
export {
  MaterialStore,
  type StoredMaterialRecord,
  type MaterialInput,
  type MaterialEdit,
  type MaterialRetag,
  MaterialConstraintError,
  FileContentNotSupportedError,
  MaterialNotFoundError,
} from "./material-store.js";

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

// M13 — the para-visible projection (the `3p/para-visible` doc model, Period-DEK
// fields only; field-split §1/§3, DECISIONS D-ARCH-FERPA-M13).
export {
  type ParaRosterMember,
  type ParaAdministerSource,
  type ParaVisibleRosterEntry,
  type ParaVisibleAdministerEntry,
  type ParaVisibleDoc,
  type ParaVisibleInput,
  buildParaVisibleProjection,
} from "./para-projection.js";
