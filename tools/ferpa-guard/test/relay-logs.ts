// Test helper: the TEACH-55 (EU-0) log contract as a FERPA assertion. Every
// relay log line carries only pino's base keys plus {record_id, route, status,
// sqlstate}, and no request value appears anywhere in the captured output.

import { expect } from "vitest";

const ALLOWED_LOG_KEYS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "reqId",
  "msg",
  "record_id",
  "route",
  "status",
  "sqlstate",
]);

/** No `forbidden` value in any line, and no line carries a key outside the allowlist. */
export function expectCleanLogs(lines: readonly string[], forbidden: readonly string[]): void {
  const all = lines.join("\n");
  for (const value of forbidden) {
    expect(all).not.toContain(value);
  }
  for (const line of lines) {
    const extra = Object.keys(JSON.parse(line) as object).filter((k) => !ALLOWED_LOG_KEYS.has(k));
    expect(extra).toEqual([]);
  }
}
