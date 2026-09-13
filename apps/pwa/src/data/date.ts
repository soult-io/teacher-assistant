import type { IsoDate } from "@teacher-assistant/schema";

/** The calendar date (UTC) of `now` as an ISO date — the probe admin date basis. */
export function isoDateOf(now: Date): IsoDate {
  return now.toISOString().slice(0, 10) as IsoDate;
}
