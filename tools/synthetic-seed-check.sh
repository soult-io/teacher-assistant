#!/usr/bin/env bash
# TEACH-74: check a built PWA (a dist/ directory, or the html root copied out of the pwa
# image) for the synthetic caseload.
#   synthetic-seed-check.sh <dir> absent    — prod: fail if ANY seed marker is present.
#   synthetic-seed-check.sh <dir> present   — QA: fail unless EVERY seed marker is present.
# CI runs both sides on every build, so a marker that stops matching the seed (renamed
# goal, reworded error) fails the QA side instead of letting the prod side pass on nothing.
# The markers are seed-only strings from apps/pwa/src/data/synthetic-seed.ts, plus the
# label of the Teacher/Para demo switch (AppShell RoleSeg), which a production bundle
# must not carry either (spec §13 A-6, TEACH-75).
set -euo pipefail

dir="${1:?usage: synthetic-seed-check.sh <dir> absent|present}"
want="${2:?usage: synthetic-seed-check.sh <dir> absent|present}"

markers=(
  "synthetic seed: cast is incomplete"
  "Two-step equations"
  "Scientific notation"
  "Para (JT)"
)

if [ ! -f "$dir/index.html" ]; then
  echo "::error::$dir has no index.html — not a built PWA, nothing would be checked"
  exit 1
fi

found=0
for marker in "${markers[@]}"; do
  if grep -rqF -- "$marker" "$dir"; then
    echo "found:   $marker"
    found=$((found + 1))
  else
    echo "missing: $marker"
  fi
done

case "$want" in
  absent)
    if [ "$found" -ne 0 ]; then
      echo "::error::the synthetic seed is in this build ($found of ${#markers[@]} markers) — a prod image must never carry it"
      exit 1
    fi
    echo "OK: no synthetic seed marker in $dir"
    ;;
  present)
    if [ "$found" -ne "${#markers[@]}" ]; then
      echo "::error::only $found of ${#markers[@]} seed markers in the QA build — the markers no longer match the seed; update them"
      exit 1
    fi
    echo "OK: all ${#markers[@]} seed markers in $dir"
    ;;
  *)
    echo "::error::second argument must be absent or present, got: $want"
    exit 1
    ;;
esac
