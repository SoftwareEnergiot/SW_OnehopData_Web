"use client";

import { useCallback, useMemo, useState } from "react";

import {
  browserViewStorage,
  clearSavedView,
  readSavedView,
  savedViewKey,
  writeSavedView,
  type SavedViewKind,
} from "@/lib/saved-view";
import type { PayloadSchemaId } from "@/lib/payload-schemas.types";

/**
 * A selection of keys (table columns, charts) that starts from the reader's
 * saved view — or the defaults — and can be saved again or reset.
 *
 * Changes apply at once; `save` keeps them for next time. `available` is the
 * offered order, which the selection always follows.
 */
export function useSavedView(
  schemaId: PayloadSchemaId,
  kind: SavedViewKind,
  available: readonly string[],
  defaults: readonly string[],
) {
  const key = savedViewKey(schemaId, kind);

  // Rendered only on the client, behind the environment guard, so storage can
  // be read during the first render.
  const [saved, setSaved] = useState<string[] | null>(() =>
    readSavedView(browserViewStorage(), key, available),
  );
  const [selected, setSelectedState] = useState<string[]>(
    () => saved ?? available.filter((item) => defaults.includes(item)),
  );

  const setSelected = useCallback(
    (keys: readonly string[]) =>
      setSelectedState(available.filter((item) => keys.includes(item))),
    [available],
  );

  const toggle = useCallback(
    (item: string) =>
      setSelectedState((current) =>
        available.filter((candidate) =>
          candidate === item ? !current.includes(item) : current.includes(candidate),
        ),
      ),
    [available],
  );

  /** Keep the current selection for next time. False if storage refused it. */
  const save = useCallback(() => {
    const ok = writeSavedView(browserViewStorage(), key, selected);
    if (ok) setSaved(selected);
    return ok;
  }, [key, selected]);

  /** Forget the saved view and go back to the defaults. */
  const reset = useCallback(() => {
    clearSavedView(browserViewStorage(), key);
    setSaved(null);
    setSelectedState(available.filter((item) => defaults.includes(item)));
  }, [key, available, defaults]);

  // Whether what is on screen differs from what would load next time.
  const unsaved = useMemo(() => {
    const reference = saved ?? available.filter((item) => defaults.includes(item));
    return (
      reference.length !== selected.length ||
      reference.some((item, index) => item !== selected[index])
    );
  }, [saved, selected, available, defaults]);

  return {
    selected,
    setSelected,
    toggle,
    save,
    reset,
    /** A view of the reader's own is saved (not the defaults). */
    hasSavedView: saved !== null,
    unsaved,
  };
}
