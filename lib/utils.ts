import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

import { fromDisplayClock, toDisplayClock } from '@/lib/timezone'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Parse a `payloads.created_at` value. Postgres hands the zone back in several
// shapes ("+00", "+00:00", "Z"), and a `timestamp` column carries none at all —
// a zone-less value is stored in UTC, so read it on that clock.
function parseCreatedAt(createdAt: string): number {
  const raw = createdAt.trim()
  // "+00" is a valid Postgres offset but not valid ISO 8601: pad it to "+00:00".
  const iso = raw.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
  const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(iso)
  const ms = Date.parse(hasZone ? iso : `${iso}Z`)
  return Number.isFinite(ms) ? ms : Date.parse(raw)
}

const pad2 = (n: number) => String(n).padStart(2, '0')

// Render a `payloads.created_at` value on the Madrid clock (CET/CEST) — the
// clock the dashboard is read on. The offset itself is not shown.
export function formatCreatedAt(createdAt: string): string {
  const ms = parseCreatedAt(createdAt)
  if (!Number.isFinite(ms)) return createdAt
  const d = new Date(toDisplayClock(ms))
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  )
}

// Read an `<input type="datetime-local">` (or `type="date"`) value as Madrid
// local time — the same clock `created_at` is displayed on — and return it as
// the UTC instant the API filters by, so the range selects exactly the rows the
// table shows. Returns null when the value is not a usable date(-time) string.
//
// `edge` says which end of the range the value bounds, and so how the precision
// the user did *not* type is filled in. A `from` value starts at the top of what
// was typed; a `to` value runs to the end of it — and a bare date (or a time
// left at 00:00, which is what the picker hands back when only a day is chosen)
// bounds the **whole day**, so picking "to: today" cannot silently drop today's
// rows.
export function createdAtBoundFromInput(
  value: string,
  edge: 'from' | 'to' = 'from',
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    value.trim(),
  )
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match

  const h = Number(hour ?? '0')
  const m = Number(minute ?? '0')
  const s = Number(second ?? '0')
  const wholeDay = h === 0 && m === 0 && s === 0

  const end = edge === 'to'
    ? wholeDay
      ? { h: 23, m: 59, s: 59, ms: 999 } // the whole day, inclusive
      : second === undefined
        ? { h, m, s: 59, ms: 999 } // through the end of the minute typed
        : { h, m, s, ms: 999 } // through the end of the second typed
    : { h, m, s, ms: 0 }

  const clockMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    end.h,
    end.m,
    end.s,
    end.ms,
  )
  return new Date(fromDisplayClock(clockMs)).toISOString()
}
