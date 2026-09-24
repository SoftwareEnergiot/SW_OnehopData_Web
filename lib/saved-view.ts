// Saved views: which table columns and which charts a reader wants to see.
//
// Kept in the browser's localStorage, one entry per environment schema and per
// kind of view, so it survives reloads and new sessions on that browser. It is
// a convenience only: storage can be blocked or cleared, and every read falls
// back to the schema's defaults.

import type { PayloadSchemaId } from "@/lib/payload-schemas.types";

export type SavedViewKind = "columns" | "charts";

/** The subset of Storage a saved view needs — injectable for tests. */
export type ViewStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function savedViewKey(schemaId: PayloadSchemaId, kind: SavedViewKind): string {
  return `onehop.view.${schemaId}.${kind}`;
}

/** The browser's localStorage, or null where it is unavailable or blocked. */
export function browserViewStorage(): ViewStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The keys saved under `key`, restricted to the ones still on offer and in
 * their offered order. Null when nothing (valid) is saved, so the caller uses
 * its defaults. An empty saved list is honoured: a reader may want no charts.
 */
export function readSavedView(
  storage: ViewStorage | null,
  key: string,
  available: readonly string[],
): string[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const saved = new Set(parsed.filter((item): item is string => typeof item === "string"));
    return available.filter((item) => saved.has(item));
  } catch {
    return null;
  }
}

/** Save a view. Returns false when the browser refused to store it. */
export function writeSavedView(
  storage: ViewStorage | null,
  key: string,
  keys: readonly string[],
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(keys));
    return true;
  } catch {
    return false;
  }
}

export function clearSavedView(storage: ViewStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing saved that can be read back either way.
  }
}
