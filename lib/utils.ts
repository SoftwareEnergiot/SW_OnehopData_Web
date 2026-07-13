import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Render a `payloads.created_at` value exactly as the database stores it — the
// clock fields are read straight off the timestamp string, with no timezone
// conversion, so the UI never shows a time that differs from the row.
export function formatCreatedAt(createdAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(createdAt)
  if (!match) return createdAt
  return `${match[1]} ${match[2]}`
}

// Interpret an `<input type="datetime-local">` value on the same clock as
// `created_at` (i.e. as-is, not shifted into the browser's timezone) so the
// range filter selects exactly the rows the table displays. Returns null when
// the value is not a complete datetime-local string.
export function createdAtBoundFromInput(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/.exec(value)
  if (!match) return null
  return `${match[1]}T${match[2]}${match[3] ?? ':00'}Z`
}
