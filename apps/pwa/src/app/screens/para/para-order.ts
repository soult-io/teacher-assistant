// Para administer rows in display order (TEACH-25). The para-visible projection
// orders by opaque studentId; the screen shows students by initials instead.

import { compareCodePoints } from "@teacher-assistant/domain-core";
import type { OpaqueId } from "@teacher-assistant/schema";
import type { ParaVisibleAdministerEntry } from "@teacher-assistant/store";
import { compareDisplayText, compareNumberAware } from "../../display-order.js";

/**
 * Initials, then studentId (same-initials students stay apart), then the
 * administer label number-aware ("Probe 2" before "Probe 10"), then the opaque
 * ids only for true duplicates.
 */
export function orderAdministerRows(
  rows: readonly ParaVisibleAdministerEntry[],
  initialsOf: (studentId: OpaqueId) => string,
): ParaVisibleAdministerEntry[] {
  return [...rows].sort(
    (a, b) =>
      compareDisplayText(initialsOf(a.studentId), initialsOf(b.studentId)) ||
      compareCodePoints(a.studentId, b.studentId) ||
      compareNumberAware(a.administerLabel, b.administerLabel) ||
      compareCodePoints(a.goalId, b.goalId) ||
      compareCodePoints(a.probeDefinitionId, b.probeDefinitionId),
  );
}
