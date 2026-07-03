"use client";

import type { AnnotatedByte } from "@/lib/payload-decoder";
import { cn } from "@/lib/utils";

interface BinaryHexViewProps {
  bytes: AnnotatedByte[];
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

export function BinaryHexView({ bytes }: BinaryHexViewProps) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4">
        <LegendDot className="bg-sky-100" label="Header (2 B)" />
        <LegendDot className="bg-emerald-100" label="Samples (28 B each)" />
        <LegendDot className="bg-violet-100" label="Context (8 B)" />
      </div>
      <div className="flex flex-col gap-4 lg:flex-row">
        <BytePanel title="Binary" bytes={bytes} render={(b) => b.binary} />
        <BytePanel title="Hexadecimal" bytes={bytes} render={(b) => b.hex} />
      </div>
    </div>
  );
}
