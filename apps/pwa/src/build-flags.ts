// Build flags (device-enrollment-spec rev 2.5 §3.4, §13 A-6).
//
// VITE_TA_SYNTHETIC=1 marks a QA/synthetic build: first setup also writes the synthetic
// caseload, and the teacher session derives the in-process para device behind the
// Teacher/Para switch. A production build (the flag unset) never seeds synthetic data and
// has no throwaway identity. Vite replaces the expression at build time, so the synthetic
// branches are constant-false in a production bundle.

export function isSyntheticBuild(): boolean {
  return import.meta.env.VITE_TA_SYNTHETIC === "1";
}
