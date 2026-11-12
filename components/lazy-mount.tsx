"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

interface LazyMountProps {
  /** Rendered once the placeholder is near the viewport and `ready` is true. */
  children: ReactNode;
  /**
   * Holds the content back until something more important has loaded (the
   * table's first page), so the page's requests do not all start at once.
   */
  ready?: boolean;
  /** Shown until then; keep it about as tall as the content to avoid a jump. */
  placeholder?: ReactNode;
  /** How far outside the viewport counts as "near". */
  rootMargin?: string;
}

/**
 * Mounts its children only when they are about to scroll into view, and only
 * once `ready`. Mounted children stay mounted: scrolling away never unmounts
 * them, so their state and data survive.
 */
export function LazyMount({
  children,
  ready = true,
  placeholder = null,
  rootMargin = "200px",
}: LazyMountProps) {
  const anchor = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    if (near) return;
    const element = anchor.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, rootMargin]);

  if (near && ready) return <>{children}</>;
  return <div ref={anchor}>{placeholder}</div>;
}
