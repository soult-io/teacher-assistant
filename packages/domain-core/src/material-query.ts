// M10-U3 — multi-facet tag query + retrieval (spec architecture/m10-u3-spec.md).
//
// A PURE query projection over the material library (U2). It filters/searches a
// teacher's already-decrypted, PII-free `Material` records by any combination of
// tag facets and returns the matches in the SAME stable order as the U2 library
// list. Read-only: no writes, no crypto, no I/O, no generation, no new
// persistence/sync/egress path — a deterministic function of (materials, filter).
//
// Combination semantics (spec §1): ACROSS facets = AND (a material must satisfy
// every specified facet); WITHIN a facet = OR (match ANY of the listed values).
// This is the "narrow by each facet, widen within a facet" behavior a teacher
// expects from faceted search.

import { compareLibraryOrder } from "./material-library.js";
import type {
  AccessBand,
  AccomMod,
  CraStage,
  LessonBlock,
  Material,
  MaterialOrigin,
  MaterialSupportType,
  MypCriterion,
  OpaqueId,
  UdlPrinciple,
} from "@teacher-assistant/schema";

/**
 * A multi-facet material filter. EVERY facet is optional; an omitted facet (or an
 * empty array / empty `text`) places no constraint on that facet. Within a facet
 * the listed values are OR'd; across facets the constraints are AND'd.
 */
export interface MaterialFilter {
  /** Match materials tagged with ANY of these KY standard codes. */
  readonly standard_codes?: readonly string[];
  /** Match materials tied to ANY of these segment-catalog ids. */
  readonly segment_ids?: readonly OpaqueId[];
  readonly support_types?: readonly MaterialSupportType[];
  readonly access_band?: readonly AccessBand[];
  readonly lesson_blocks?: readonly LessonBlock[];
  readonly udl_principles?: readonly UdlPrinciple[];
  readonly cra_stages?: readonly CraStage[];
  readonly accom_mod?: readonly AccomMod[];
  readonly myp_criteria?: readonly MypCriterion[];
  readonly origin?: readonly MaterialOrigin[];
  /** Case-insensitive substring match on `title` (and text body / link label). */
  readonly text?: string;
  /** Include retired (`active=false`) materials. Default FALSE (active only). */
  readonly include_retired?: boolean;
}

/**
 * The matching materials, in the stable U2 library order. Pure: the input array
 * is never mutated (`filter` produces a fresh array before `sort`).
 *
 * Default (no `include_retired`) returns only active materials; with an empty
 * filter it equals `buildMaterialLibrary(materials)`.
 */
export function queryMaterials(
  materials: readonly Material[],
  filter: MaterialFilter,
): readonly Material[] {
  const base = filter.include_retired ? materials : materials.filter((m) => m.active);
  return base.filter((m) => matchesFilter(m, filter)).sort(compareLibraryOrder);
}

/** A material passes iff it satisfies EVERY specified facet (AND across facets). */
function matchesFilter(m: Material, f: MaterialFilter): boolean {
  return (
    matchArray(f.standard_codes, m.standard_codes) &&
    matchArray(f.segment_ids, m.segment_ids) &&
    matchArray(f.support_types, m.support_types) &&
    matchArray(f.lesson_blocks, m.lesson_blocks) &&
    matchArray(f.udl_principles, m.udl_principles) &&
    matchArray(f.cra_stages, m.cra_stages) &&
    matchArray(f.myp_criteria, m.myp_criteria ?? []) &&
    matchScalar(f.access_band, m.access_band) &&
    matchScalar(f.accom_mod, m.accom_mod) &&
    matchScalar(f.origin, m.origin) &&
    matchText(f.text, m)
  );
}

/**
 * A scalar material field (e.g. `access_band`) matches when the filter lists its
 * value (OR within the facet). An omitted or empty filter list = no constraint.
 */
function matchScalar<T>(filterValues: readonly T[] | undefined, value: T): boolean {
  if (filterValues === undefined || filterValues.length === 0) {
    return true;
  }
  return filterValues.includes(value);
}

/**
 * A multi-valued material field (e.g. `support_types`) matches when its set
 * intersects the filter's listed values (OR within the facet). An omitted or
 * empty filter list = no constraint.
 */
function matchArray<T>(filterValues: readonly T[] | undefined, values: readonly T[]): boolean {
  if (filterValues === undefined || filterValues.length === 0) {
    return true;
  }
  return filterValues.some((v) => values.includes(v));
}

/**
 * Case-insensitive substring match on the title plus the cheap in-record text
 * (a `text` content body, a `link` content label). An omitted or empty query =
 * no constraint. Uses `toLowerCase` (substring test only — never localeCompare).
 */
function matchText(query: string | undefined, m: Material): boolean {
  if (query === undefined || query === "") {
    return true;
  }
  const needle = query.toLowerCase();
  const haystacks = [m.title];
  if (m.content.kind === "text") {
    haystacks.push(m.content.body);
  } else if (m.content.kind === "link" && m.content.label !== undefined) {
    haystacks.push(m.content.label);
  }
  return haystacks.some((h) => h.toLowerCase().includes(needle));
}
