"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PayloadAnalysisView } from "@/components/payload-analysis";
import { analyzePayload, hexToBytes } from "@/lib/payload-decoder";
import { formatErrorMask } from "@/lib/payload-errors";
import type { PayloadRecord } from "@/lib/types";
import { toast } from "sonner";
import { Database, RefreshCw, X } from "lucide-react";

export function ReceivedPayloads() {
  const [rows, setRows] = useState<PayloadRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PayloadRecord | null>(null);
  // Received-timestamp range filter. Values come from <input type="datetime-local">,
  // i.e. local wall-clock strings like "2026-07-06T14:30" (no timezone).
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const fetchPayloads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      // Convert the local datetime-local value to an ISO instant so the range
      // is interpreted in the user's timezone, matching what the table shows.
      if (from) {
        const d = new Date(from);
        if (!Number.isNaN(d.getTime())) params.set("from", d.toISOString());
      }
      if (to) {
        const d = new Date(to);
        if (!Number.isNaN(d.getTime())) params.set("to", d.toISOString());
      }
      const response = await fetch(`/api/payloads?${params.toString()}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (result.success) {
        setRows(result.data ?? []);
      } else {
        toast.error(result.error ?? "Failed to load payloads");
      }
    } catch {
      // The list needs Supabase configured; fail quietly with a hint.
      toast.error("Could not load stored payloads (is Supabase configured?)");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    fetchPayloads();
  }, [fetchPayloads]);

  const clearFilter = useCallback(() => {
    setFrom("");
    setTo("");
  }, []);

  const hasFilter = from !== "" || to !== "";

  const selectedAnalysis = selected
    ? safeAnalyze(selected.payload_hex)
    : null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            Received payloads
          </CardTitle>
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchPayloads}
              className="gap-2"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="received-from" className="text-xs text-muted-foreground">
                Received from
              </Label>
              <Input
                id="received-from"
                type="datetime-local"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
                className="w-auto"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="received-to" className="text-xs text-muted-foreground">
                Received to
              </Label>
              <Input
                id="received-to"
                type="datetime-local"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                className="w-auto"
              />
            </div>
            {hasFilter && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilter}
                className="gap-2"
              >
                <X className="h-4 w-4" />
                Clear
              </Button>
            )}
          </div>
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Loading…
            </p>
          ) : rows.length === 0 ? (
            hasFilter ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No payloads received in the selected time range.
              </p>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No payloads stored yet. Send one to{" "}
                <span className="font-mono">POST /api/payloads</span> or use the
                Playground.
              </p>
            )
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead className="text-right">Ver.</TableHead>
                  <TableHead className="text-right">Samples</TableHead>
                  <TableHead>Error mask</TableHead>
                  <TableHead className="text-right">Counter</TableHead>
                  <TableHead className="text-right">Bytes</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs">
                      {new Date(row.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {row.payload_version}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {row.sample_count}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={row.error_mask === 0 ? "secondary" : "destructive"}
                      >
                        {formatErrorMask(row.error_mask)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {row.reporting_counter}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {row.byte_length}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setSelected((prev) => (prev?.id === row.id ? null : row))
                        }
                      >
                        {selected?.id === row.id ? "Hide" : "Inspect"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {selectedAnalysis && <PayloadAnalysisView analysis={selectedAnalysis} />}
    </div>
  );
}

// Decode a stored hex string for inspection; returns null on any error so a
// corrupt row cannot crash the view.
function safeAnalyze(hex: string) {
  try {
    return analyzePayload(hexToBytes(hex));
  } catch {
    return null;
  }
}
