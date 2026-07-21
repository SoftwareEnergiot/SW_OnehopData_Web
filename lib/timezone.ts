// The clock the dashboard is read on. Payloads are stored in UTC
// (`payloads.created_at` is a TIMESTAMPTZ); everything the user sees — table
// stamps, chart axes, tooltips — and everything the user types — the range
// filter — is on Madrid local time (CET/CEST), with no offset shown.

export const DISPLAY_TIME_ZONE = "Europe/Madrid";

const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Madrid's offset from UTC, in ms, at the given instant (+1 h or +2 h). */
function offsetMs(utcMs: number): number {
  const parts = partsFormat.formatToParts(new Date(utcMs));
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
  // Sub-second precision is lost by the formatter; add it back so the offset is
  // a whole-minute shift and nothing else.
  return asUtc - (utcMs - (((utcMs % 1000) + 1000) % 1000));
}

/**
 * Shift an instant onto the Madrid clock: the returned epoch's UTC fields
 * (`getUTCHours()` and friends) read as Madrid wall-clock fields. Use it only
 * for formatting — the value is not a real instant.
 */
export function toDisplayClock(utcMs: number): number {
  return utcMs + offsetMs(utcMs);
}

/**
 * The inverse: read an epoch whose UTC fields are Madrid wall-clock fields back
 * as a real instant. During the spring-forward gap (a wall clock that never
 * happens) and the autumn overlap this resolves to the offset in force around
 * the transition, which is what a range filter wants.
 */
export function fromDisplayClock(clockMs: number): number {
  const guess = clockMs - offsetMs(clockMs);
  return clockMs - offsetMs(guess);
}
