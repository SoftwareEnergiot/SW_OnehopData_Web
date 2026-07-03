"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BinaryHexView } from "@/components/binary-hex-view";
import {
  SAMPLE_FIELDS,
  type PayloadAnalysis,
} from "@/lib/payload-decoder";
import { formatErrorMask } from "@/lib/payload-errors";
import {
  Binary,
  FileDigit,
  Layers,
  ListTree,
  TriangleAlert,
} from "lucide-react";

interface PayloadAnalysisViewProps {
  analysis: PayloadAnalysis;
}

// Render a raw channel value together with its scaled engineering value when a
// scaling factor is defined (raw / factor).
function scaledValue(raw: number, factor: number): string {
  if (factor === 1) return "—";
  return (raw / factor).toString();
}

function SummaryBadges({ analysis }: PayloadAnalysisViewProps) {
  const { meta, decoded } = analysis;
  const lengthOk = meta.byteLength === meta.expectedLength;
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant="secondary">Version {decoded.payload_version}</Badge>
      <Badge variant="secondary">{decoded.sample_count} sample(s)</Badge>
      <Badge variant={lengthOk ? "secondary" : "destructive"}>
        {meta.byteLength} / {meta.expectedLength} bytes
      </Badge>
      <Badge variant="secondary">
        mask {formatErrorMask(decoded.error_mask)}
      </Badge>
      <Badge variant="secondary">counter {decoded.reporting_counter}</Badge>
    </div>
  );
}

function HeaderSection({ analysis }: PayloadAnalysisViewProps) {
  const { decoded } = analysis;
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <FileDigit className="h-4 w-4 text-primary" />
        <CardTitle>Header</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Field</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Payload id / version</TableCell>
              <TableCell className="text-muted-foreground">uint8</TableCell>
              <TableCell className="text-right font-mono">
                {decoded.payload_version}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Sample count</TableCell>
              <TableCell className="text-muted-foreground">uint8</TableCell>
              <TableCell className="text-right font-mono">
                {decoded.sample_count}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SamplesSection({ analysis }: PayloadAnalysisViewProps) {
  const { decoded } = analysis;
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Layers className="h-4 w-4 text-primary" />
        <CardTitle>Samples ({decoded.sample_count})</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        {decoded.samples.map((sample, index) => (
          <div key={index} className="rounded-lg border">
            <div className="border-b bg-muted/40 px-3 py-2 text-sm font-semibold">
              sample[{index}]
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Channel</TableHead>
                  <TableHead className="text-right">Raw</TableHead>
                  <TableHead className="text-right">Scaled</TableHead>
                  <TableHead>Unit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {SAMPLE_FIELDS.map((field) => (
                  <TableRow key={field.key}>
                    <TableCell>
                      <span className="font-mono text-xs">{field.key}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {field.label}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {sample[field.key]}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {scaledValue(sample[field.key], field.factor)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {field.unit}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ContextSection({ analysis }: PayloadAnalysisViewProps) {
  const { decoded } = analysis;
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <ListTree className="h-4 w-4 text-primary" />
        <CardTitle>Batch context</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Field</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Error mask</TableCell>
              <TableCell className="text-muted-foreground">uint32</TableCell>
              <TableCell className="text-right font-mono">
                {formatErrorMask(decoded.error_mask)} ({decoded.error_mask})
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Reporting counter</TableCell>
              <TableCell className="text-muted-foreground">uint32</TableCell>
              <TableCell className="text-right font-mono">
                {decoded.reporting_counter}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ErrorSection({ analysis }: PayloadAnalysisViewProps) {
  const { decoded } = analysis;
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <TriangleAlert className="h-4 w-4 text-primary" />
        <CardTitle>Error mask ({formatErrorMask(decoded.error_mask)})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {decoded.errors.map((err) => (
            <Badge
              key={err.code}
              variant="outline"
              style={{ borderColor: err.color, color: err.color }}
            >
              {err.name}
            </Badge>
          ))}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Tag</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {decoded.errors.map((err) => (
              <TableRow key={err.code}>
                <TableCell className="font-mono">{err.code}</TableCell>
                <TableCell>
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full align-middle"
                    style={{ backgroundColor: err.color }}
                  />
                  <span className="ml-2 align-middle font-mono text-xs">
                    {err.name}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {err.description}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function PayloadAnalysisView({ analysis }: PayloadAnalysisViewProps) {
  return (
    <div className="space-y-6">
      <SummaryBadges analysis={analysis} />

      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <Binary className="h-4 w-4 text-primary" />
          <CardTitle>Binary vs. hexadecimal</CardTitle>
        </CardHeader>
        <CardContent>
          <BinaryHexView bytes={analysis.bytes} />
        </CardContent>
      </Card>

      <HeaderSection analysis={analysis} />
      <SamplesSection analysis={analysis} />
      <ContextSection analysis={analysis} />
      <ErrorSection analysis={analysis} />
    </div>
  );
}
