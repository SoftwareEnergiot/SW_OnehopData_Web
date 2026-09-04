"use client";

import type { AnnotatedByte, PayloadAnalysis } from "@/lib/payload-decoder";
import { cn } from "@/lib/utils";

interface BinaryHexViewProps {
  bytes: AnnotatedByte[];
  // Section sizes differ per payload version (V0 is 2/28/8, V1 is 14/32/36),
  // so the legend is labelled from the analysed payload rather than hardcoded.
  meta?: PayloadAnalysis["meta"];
}

// Background/foreground classes for each protocol section, so the same byte is
// highlighted identically in both the binary and hex panels.
function sectionClasses(byte: AnnotatedByte): string {
  switch (byte.section) {
    case "header":
      return "bg-sky-100 text-sky-900";
    case "context":
      return "bg-violet-100 text-violet-900";
    case "sample":
      return (byte.sampleIndex ?? 0) % 2 === 0
        ? "bg-emerald-50 text-emerald-900"
        : "bg-emerald-100 text-emerald-900";
  }
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("inline-block h-3 w-3 rounded-sm border", className)} />
      <span className="text-xs text-muted-foreground">{label}</span>
    </span>
  );
}

function BytePanel({
  bytes,
  render,
  title,
}: {
  bytes: AnnotatedByte[];
  render: (b: AnnotatedByte) => string;
  title: string;
}) {
  return (
    <div className="flex-1 space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
        {bytes.map((b) => (
          <span
            key={b.offset}
            title={`byte ${b.offset} · ${b.section}${
              b.sampleIndex !== null ? ` ${b.sampleIndex}` : ""
            }`}
            className={cn("rounded px-1 py-0.5", sectionClasses(b))}
          >
            {render(b)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function BinaryHexView({ bytes, meta }: BinaryHexViewProps) {
  const headerSize = meta?.headerSize ?? 2;
  const sampleSize = meta?.sampleSize ?? 28;
  const contextSize = meta?.contextSize ?? 8;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4">
        <LegendDot className="bg-sky-100" label={`Header (${headerSize} B)`} />
        <LegendDot
          className="bg-emerald-100"
          label={`Samples (${sampleSize} B each)`}
        />
        <LegendDot className="bg-violet-100" label={`Context (${contextSize} B)`} />
      </div>
      <div className="flex flex-col gap-4 lg:flex-row">
        <BytePanel title="Binary" bytes={bytes} render={(b) => b.binary} />
        <BytePanel title="Hexadecimal" bytes={bytes} render={(b) => b.hex} />
      </div>
    </div>
  );
}
