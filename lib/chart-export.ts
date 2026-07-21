// Browser-side export of the reception-timeline charts: the bucket data as a
// CSV file, and the plots themselves as a single PNG image. Kept apart from the
// React component so the (DOM-heavy) rasterisation logic can evolve on its own.

import { formatTimestamp, type Timeline } from "@/lib/payload-timeline";

/* -------------------------------------------------------------------- CSV */

// Escape a single CSV field per RFC 4180: wrap in quotes when it contains a
// comma, quote, or newline, doubling any embedded quotes.
function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// One number, formatted for a cell: an em dash for a bucket that received
// nothing, mean bytes trimmed to one decimal to match the on-screen table.
function cell(value: number | null, decimals = 0): string {
  if (value === null) return "";
  return Number.isInteger(value) ? String(value) : value.toFixed(decimals);
}

// Build a CSV of the timeline's buckets — the same rows the "Show values" table
// renders, one line per bucket. Emitted CRLF-terminated for Excel.
export function buildTimelineCsv(timeline: Timeline): string {
  const header = [
    "Bucket start",
    "Payloads",
    "Min bytes",
    "Mean bytes",
    "Max bytes",
    "Counter (last)",
    "Min counter",
    "Max counter",
  ];
  const lines = [header.map(escapeCsvField).join(",")];
  for (const bucket of timeline.buckets) {
    const row = [
      formatTimestamp(bucket.start),
      String(bucket.count),
      cell(bucket.minBytes),
      cell(bucket.meanBytes, 1),
      cell(bucket.maxBytes),
      cell(bucket.lastCounter),
      cell(bucket.minCounter),
      cell(bucket.maxCounter),
    ];
    lines.push(row.map(escapeCsvField).join(","));
  }
  return lines.join("\r\n");
}

/* -------------------------------------------------------------------- PNG */

// SVG presentation properties that carry the chart's look. The plots colour
// everything through CSS custom properties (var(--primary)) and Tailwind
// utility classes; getComputedStyle resolves both to concrete values, which we
// copy inline so the detached clone renders without the page's stylesheet.
const STYLE_PROPS = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "font-variant-numeric",
  "text-anchor",
  "dominant-baseline",
] as const;

// Copy the resolved styles of every node in `source` onto the matching node in
// `clone` (same tree shape, produced by cloneNode(true)).
function inlineStyles(source: Element, clone: Element): void {
  const computed = getComputedStyle(source);
  const declarations = STYLE_PROPS.map(
    (prop) => `${prop}:${computed.getPropertyValue(prop)}`,
  ).join(";");
  clone.setAttribute("style", declarations);

  const sourceChildren = source.children;
  const cloneChildren = clone.children;
  for (let i = 0; i < sourceChildren.length; i++) {
    inlineStyles(sourceChildren[i], cloneChildren[i]);
  }
}

// Rasterise one <svg> into an <img> ready to draw onto a canvas, carrying its
// resolved styles so it looks identical to the on-screen plot.
async function loadSvgImage(
  svg: SVGSVGElement,
): Promise<{ image: HTMLImageElement; width: number; height: number }> {
  const width = Number(svg.getAttribute("width")) || svg.clientWidth;
  const height = Number(svg.getAttribute("height")) || svg.clientHeight;

  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineStyles(svg, clone);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));

  const markup = new XMLSerializer().serializeToString(clone);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

  const image = new Image();
  image.width = width;
  image.height = height;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Could not rasterise the chart."));
    image.src = url;
  });

  return { image, width, height };
}

// Walk up from an element to the first ancestor with a non-transparent
// background, so the PNG sits on the card's colour rather than nothing (which
// canvas fills black and swallows the axis text).
function resolveColor(el: Element | null, property: string): string {
  let node: Element | null = el;
  while (node) {
    const value = getComputedStyle(node).getPropertyValue(property);
    if (value && value !== "transparent" && !value.startsWith("rgba(0, 0, 0, 0)")) {
      return value;
    }
    node = node.parentElement;
  }
  return property === "background-color" ? "#ffffff" : "#000000";
}

export interface ChartFigure {
  title: string;
  svg: SVGSVGElement;
}

// Compose the given figures into a single tall PNG: each plot stacked under its
// title, on the card's background, at device resolution for a crisp export.
export async function chartsToPngBlob(
  figures: ChartFigure[],
  container: Element,
): Promise<Blob> {
  if (figures.length === 0) {
    throw new Error("No charts to export.");
  }

  const scale = Math.min(3, Math.max(1, window.devicePixelRatio || 1)) * 2;
  const padding = 24;
  const gap = 32;
  const titleHeight = 24;
  const background = resolveColor(container, "background-color");
  const foreground = resolveColor(container, "color");

  const rendered = await Promise.all(figures.map((f) => loadSvgImage(f.svg)));
  const contentWidth = Math.max(...rendered.map((r) => r.width));
  const contentHeight = rendered.reduce(
    (sum, r) => sum + titleHeight + r.height + gap,
    0,
  );
  const width = contentWidth + padding * 2;
  const height = contentHeight - gap + padding * 2;

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser.");
  ctx.scale(scale, scale);

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  ctx.textBaseline = "top";
  let y = padding;
  rendered.forEach((r, i) => {
    ctx.fillStyle = foreground;
    ctx.font =
      '600 13px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(figures[i].title, padding, y);
    y += titleHeight;
    ctx.drawImage(r.image, padding, y, r.width, r.height);
    y += r.height + gap;
  });

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode the PNG."));
    }, "image/png");
  });
}

/* --------------------------------------------------------------- download */

// Trigger a browser download of a Blob under `filename`.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// A filesystem-safe timestamp (YYYY-MM-DD-HH-MM-SS) for export filenames.
export function exportStamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}
