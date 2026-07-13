"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { PayloadCharts } from "@/components/payload-charts";
import { analyzePayload, hexToBytes } from "@/lib/payload-decoder";
import { formatErrorMask } from "@/lib/payload-errors";
import { createdAtBoundFromInput, formatCreatedAt } from "@/lib/utils";
import type { PayloadRecord } from "@/lib/types";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Database,
  RefreshCw,
  X,
} from "lucide-react";

const PAGE_SIZES = [25, 50, 100, 200];

export function ReceivedPayloads() {
  const [rows, setRows] = useState<PayloadRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Received-timestamp range filter. Values come from <input type="datetime-local">,
  // i.e. wall-clock strings like "2026-07-06T14:30", read on the same clock as
  // the created_at values shown in the table.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Paging through every stored payload in the selected range.
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  // Set when the inspector steps past the edge of the current page: once the
  // next page has loaded, select its first ("first") or last ("last") row so
  // navigation continues seamlessly across the whole range.
  const [selectEdge, setSelectEdge] = useState<"first" | "last" | null>(null);
  // Bumped by Refresh so the charts refetch alongside the table.
  const [refreshKey, setRefreshKey] = useState(0);

  // The range as ISO instants — the one slice both the charts and the table
  // are drawn from, so their numbers always agree.
  const fromBound = createdAtBoundFromInput(from);
  const toBound = createdAtBoundFromInput(to);

  const fetchPayloads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(page * pageSize),
      });
      const fromBound = createdAtBoundFromInput(from);
      if (fromBound) params.set("from", fromBound);
      const toBound = createdAtBoundFromInput(to);
      if (toBound) params.set("to", toBound);

      const response = await fetch(`/api/payloads?${params.toString()}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (result.success) {
        setRows(result.data ?? []);
        setTotal(result.total ?? 0);
      } else {
        toast.error(result.error ?? "Failed to load payloads");
      }
    } catch {
      // The list needs Supabase configured; fail quietly with a hint.
      toast.error("Could not load stored payloads (is Supabase configured?)");
    } finally {
      setLoading(false);
    }
  }, [from, to, page, pageSize]);

  useEffect(() => {
    fetchPayloads();
  }, [fetchPayloads]);

  // Land on the requested edge of a page the inspector just navigated into.
  useEffect(() => {
    if (!selectEdge || rows.length === 0) return;
    const row = selectEdge === "first" ? rows[0] : rows[rows.length - 1];
    setSelectedId(row.id);
    setSelectEdge(null);
  }, [rows, selectEdge]);

  // Any change to the range or the page size restarts paging from the first
  // page, so the offset can never point past the new result set.
  const changeFrom = useCallback((value: string) => {
    setFrom(value);
    setPage(0);
  }, []);

  const changeTo = useCallback((value: string) => {
    setTo(value);
    setPage(0);
  }, []);

  const changePageSize = useCallback((value: number) => {
    setPageSize(value);
    setPage(0);
  }, []);

  const clearFilter = useCallback(() => {
    setFrom("");
    setTo("");
    setPage(0);
  }, []);

  const hasFilter = from !== "" || to !== "";
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const firstRowNumber = total === 0 ? 0 : page * pageSize + 1;
  const lastRowNumber = page * pageSize + rows.length;

  const selectedIndex = rows.findIndex((row) => row.id === selectedId);
  const selected = selectedIndex === -1 ? null : rows[selectedIndex];

  const selectedAnalysis = useMemo(
    () => (selected ? safeAnalyze(selected.payload_hex) : null),
    [selected],
  );

  // Position of the selection among *all* payloads in the range, not just the
  // rows of the current page.
  const selectedNumber = page * pageSize + selectedIndex + 1;
  const hasNewer = selectedIndex > 0 || page > 0;
  const hasOlder = selectedNumber < total;

  // Step through the payloads one at a time, crossing page boundaries so the
  // inspector can walk every stored payload in the range.
  const stepSelection = useCallback(
    (delta: 1 | -1) => {
      if (selectedIndex === -1) return;
      const next = rows[selectedIndex + delta];
      if (next) {
        setSelectedId(next.id);
      } else if (delta === 1 && page < pageCount - 1) {
        setSelectEdge("first");
        setPage((p) => p + 1);
      } else if (delta === -1 && page > 0) {
        setSelectEdge("last");
        setPage((p) => p - 1);
      }
    },
    [rows, selectedIndex, page, pageCount],
  );

  return (
    <div className="space-y-6">
      {/* One filter row, above everything it scopes: the charts and the table
          are drawn from the same slice, so their numbers always agree. */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="received-from" className="text-xs text-muted-foreground">
              Received from
            </Label>
            <Input
              id="received-from"
              type="datetime-local"
              value={from}
              max={to || undefined}
              onChange={(e) => changeFrom(e.target.value)}
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
              onChange={(e) => changeTo(e.target.value)}
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              fetchPayloads();
              setRefreshKey((k) => k + 1);
            }}
            className="ml-auto gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </CardContent>
      </Card>

      <PayloadCharts
        from={fromBound}
        to={toBound}
        refreshKey={refreshKey}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            Received payloads
          </CardTitle>
          <CardAction>
            <div className="flex items-center gap-2">
              <Label
                htmlFor="page-size"
                className="text-xs text-muted-foreground"
              >
                Per page
              </Label>
              <select
                id="page-size"
                value={pageSize}
                onChange={(e) => changePageSize(Number(e.target.value))}
                className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
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
            <>
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
                    <TableRow
                      key={row.id}
                      data-state={row.id === selectedId ? "selected" : undefined}
                    >
                      <TableCell className="font-mono text-xs">
                        {formatCreatedAt(row.created_at)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {row.payload_version}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {row.sample_count}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.error_mask === 0 ? "secondary" : "destructive"
                          }
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
                            setSelectedId((prev) =>
                              prev === row.id ? null : row.id,
                            )
                          }
                        >
                          {selectedId === row.id ? "Hide" : "Inspect"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Showing{" "}
                  <span className="font-mono">
                    {firstRowNumber}–{lastRowNumber}
                  </span>{" "}
                  of <span className="font-mono">{total}</span> payload(s)
                  {hasFilter ? " in the selected time range" : ""} · page{" "}
                  <span className="font-mono">{page + 1}</span> of{" "}
                  <span className="font-mono">{pageCount}</span>
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(0)}
                    disabled={page === 0}
                    aria-label="First page"
                  >
                    <ChevronsLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="gap-1"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPage((p) => Math.min(pageCount - 1, p + 1))
                    }
                    disabled={page >= pageCount - 1}
                    className="gap-1"
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(pageCount - 1)}
                    disabled={page >= pageCount - 1}
                    aria-label="Last page"
                  >
                    <ChevronsRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              Payload {formatCreatedAt(selected.created_at)}
            </CardTitle>
            <CardAction>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  <span className="font-mono">{selectedNumber}</span> of{" "}
                  <span className="font-mono">{total}</span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => stepSelection(-1)}
                  disabled={!hasNewer || loading}
                  className="gap-1"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Newer
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => stepSelection(1)}
                  disabled={!hasOlder || loading}
                  className="gap-1"
                >
                  Older
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedId(null)}
                  aria-label="Close inspector"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </CardAction>
          </CardHeader>
          <CardContent>
            {selectedAnalysis ? (
              <PayloadAnalysisView analysis={selectedAnalysis} />
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                This payload could not be decoded from its stored hex.
              </p>
            )}
          </CardContent>
        </Card>
      )}
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
