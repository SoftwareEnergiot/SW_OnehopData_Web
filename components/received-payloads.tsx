"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Database, RefreshCw } from "lucide-react";

export function ReceivedPayloads() {
  const [rows, setRows] = useState<PayloadRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PayloadRecord | null>(null);

  const fetchPayloads = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/payloads?limit=50", {
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
  }, []);

  useEffect(() => {
    fetchPayloads();
  }, [fetchPayloads]);

  const selectedAnalysis = selected
    ? safeAnalyze(selected.payload_hex)
    : null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            Received payloads
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchPayloads}
            className="gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Loading…
            </p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No payloads stored yet. Send one to{" "}
              <span className="font-mono">POST /api/payloads</span> or use the
              Playground.
            </p>
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
