"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
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
import { LazyMount } from "@/components/lazy-mount";
import { PayloadCell, isNumericField } from "@/components/payload-cell";
import { useActiveEnvironment } from "@/components/environment-provider";
import { useSavedView } from "@/components/use-saved-view";
import { ViewPicker } from "@/components/view-picker";
import { analyzePayload, hexToBytes } from "@/lib/payload-decoder";
import { createdAtBoundFromInput, formatCreatedAt } from "@/lib/utils";
import { buildCsv, downloadCsv } from "@/lib/payload-csv";
import { exportRange } from "@/lib/payload-export";
import { NO_DEVICE_UID } from "@/lib/payload-filters";
import type { PayloadCursor } from "@/lib/payload-cursor";
import { appendBatch, nextBatchSize } from "@/lib/payload-list";
import { ENVIRONMENT_PARAM } from "@/lib/environments";
import { columnValue, fieldLabel, fieldOf } from "@/lib/payload-schemas";
import type { PayloadRecord, PayloadRow } from "@/lib/types";

// One entry of GET /api/payloads/devices.
interface DeviceOption {
  device_uid: string;
  payloads: number;
  last_seen: string;
}
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Database,
  Download,
  Hash,
  RefreshCw,
  X,
} from "lucide-react";

// Loaded on demand, so the first paint ships only the table: the charts once
// they are about to scroll into view, the inspectors once a row is opened.
const PayloadCharts = dynamic(
  () => import("@/components/payload-charts").then((m) => m.PayloadCharts),
  { loading: () => <SectionPlaceholder label="Loading charts…" /> },
);
const PayloadAnalysisView = dynamic(
  () => import("@/components/payload-analysis").then((m) => m.PayloadAnalysisView),
  { loading: () => <SectionPlaceholder label="Loading inspector…" /> },
);
const PayloadRecordView = dynamic(
  () => import("@/components/payload-record-view").then((m) => m.PayloadRecordView),
  { loading: () => <SectionPlaceholder label="Loading inspector…" /> },
);

function SectionPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">
      {label}
    </div>
  );
}

// Rows pulled per request when gathering a full range for CSV export. Kept at
// or below the Supabase default row cap so a single page never silently drops
// rows off the end.
export function ReceivedPayloads() {
  // The dataset this view reads. Guaranteed present: the dashboard only
  // renders behind <EnvironmentGuard>.
  const { environment, schema } = useActiveEnvironment();

  // The columns of the list: any field of the schema, as the reader picked
  // them (saved per environment in this browser), or the schema's defaults.
  const fieldKeys = useMemo(() => schema.fields.map((field) => field.key), [schema]);
  const columnsView = useSavedView(schema.id, "columns", fieldKeys, schema.listColumns);
  const listFields = useMemo(
    () =>
      columnsView.selected
        .map((key) => fieldOf(schema, key))
        .filter((field): field is NonNullable<typeof field> => field !== undefined),
    [schema, columnsView.selected],
  );

  // The rows loaded so far, newest first: a first small batch, then whatever
  // the reader asked for with "Load more" (lib/payload-list).
  const [rows, setRows] = useState<PayloadRow[]>([]);
  // Where the next batch starts; null once the oldest row has been loaded.
  const [cursor, setCursor] = useState<PayloadCursor | null>(null);
  const [batchesLoaded, setBatchesLoaded] = useState(0);
  // The number of rows in the filter, only once the reader asked for it: an
  // exact count of a large table outlasts the database timeout.
  const [total, setTotal] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped by every first-batch load, so a batch or a count that answers after
  // the filter changed is dropped instead of mixed into the new rows.
  const generation = useRef(0);
  // Set once the first page has arrived. The device list and the charts wait
  // for it, so opening the dashboard starts one request instead of three.
  const [firstPageLoaded, setFirstPageLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Received-timestamp range filter. Values come from <input type="datetime-local">,
  // i.e. wall-clock strings like "2026-07-06T14:30", read on the same clock as
  // the created_at values shown in the table.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Device filter: "" = every device, NO_DEVICE_UID = payloads without a UID
  // (V0), otherwise a canonical "00:12:4B:…" UID. Shared with the charts, since
  // one battery or coverage line drawn across several devices means nothing.
  const [deviceUid, setDeviceUid] = useState("");
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [devicesWithoutUid, setDevicesWithoutUid] = useState(false);
  // Bumped by Refresh so the charts refetch alongside the table.
  const [refreshKey, setRefreshKey] = useState(0);
  // True while a CSV export is gathering rows, to disable the button and show
  // progress.
  const [exporting, setExporting] = useState(false);
  const [exportedRows, setExportedRows] = useState(0);
  const [exportReached, setExportReached] = useState<Date | null>(null);

  // A row's identity, read through the schema's primary key.
  const rowId = useCallback(
    (row: PayloadRow) => String(columnValue(row, schema.primaryKey)),
    [schema.primaryKey],
  );

  // The table's filter as query parameters, without paging. The environment
  // is named on every request, so a row can only ever come from the active
  // environment's table.
  const filterParams = useCallback(() => {
    const params = new URLSearchParams();
    const fromBound = createdAtBoundFromInput(from, "from");
    if (fromBound) params.set("from", fromBound);
    const toBound = createdAtBoundFromInput(to, "to");
    if (toBound) params.set("to", toBound);
    if (deviceUid) params.set("device_uid", deviceUid);
    params.set(ENVIRONMENT_PARAM, environment.name);
    return params;
  }, [from, to, deviceUid, environment.name]);

  // One batch of rows, without a count. Throws with the server's message.
  const fetchBatch = useCallback(
    async (limit: number, after: PayloadCursor | null) => {
      const params = filterParams();
      params.set("limit", String(limit));
      params.set("count", "none");
      if (after) {
        params.set("before", after.before);
        params.set("before_id", after.beforeId);
      }
      const response = await fetch(`/api/payloads?${params.toString()}`, {
        cache: "no-store",
      });
      const result = await response.json().catch(() => ({ success: false }));
      if (!result.success) {
        throw new Error(
          result.details ?? result.error ?? `Failed to load payloads (HTTP ${response.status})`,
        );
      }
      return {
        data: (result.data ?? []) as PayloadRow[],
        next: (result.next_cursor ?? null) as PayloadCursor | null,
      };
    },
    [filterParams],
  );

  // The first batch: what opening the dashboard, a filter change or Refresh
  // loads. Replaces whatever was loaded before.
  const fetchPayloads = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setLoadingMore(false);
    setTotal(null);
    setCounting(false);
    try {
      const { data, next } = await fetchBatch(nextBatchSize(0), null);
      if (current !== generation.current) return;
      setRows(data);
      setCursor(next);
      setBatchesLoaded(1);
    } catch (error) {
      if (current !== generation.current) return;
      setRows([]);
      setCursor(null);
      setBatchesLoaded(0);
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not load stored payloads (is Supabase configured?)",
      );
    } finally {
      if (current === generation.current) {
        setLoading(false);
        setFirstPageLoaded(true);
      }
    }
  }, [fetchBatch]);

  useEffect(() => {
    fetchPayloads();
  }, [fetchPayloads]);

  // The next, larger batch, appended below the rows already shown. With
  // `selectFirst`, the inspector moves onto its first row (stepping "Older"
  // past the last loaded row).
  const loadMore = useCallback(
    async (selectFirst = false) => {
      if (!cursor || loadingMore || loading) return;
      const current = generation.current;
      setLoadingMore(true);
      try {
        const { data, next } = await fetchBatch(nextBatchSize(batchesLoaded), cursor);
        if (current !== generation.current) return;
        setRows((prev) => appendBatch(prev, data, rowId));
        setCursor(next);
        setBatchesLoaded((n) => n + 1);
        if (selectFirst && data.length > 0) setSelectedId(rowId(data[0]));
      } catch (error) {
        if (current !== generation.current) return;
        toast.error(error instanceof Error ? error.message : "Could not load more payloads");
      } finally {
        if (current === generation.current) setLoadingMore(false);
      }
    },
    [cursor, loadingMore, loading, fetchBatch, batchesLoaded, rowId],
  );

  // The exact number of rows in the filter, only on request. On a large,
  // unfiltered table it can outlast the database timeout; then it says so
  // instead of failing the table.
  const countTotal = useCallback(async () => {
    const current = generation.current;
    setCounting(true);
    try {
      const params = filterParams();
      params.set("limit", "1");
      const response = await fetch(`/api/payloads?${params.toString()}`, {
        cache: "no-store",
      });
      const result = await response.json().catch(() => ({ success: false }));
      if (current !== generation.current) return;
      if (result.success && typeof result.total === "number") {
        setTotal(result.total);
      } else {
        toast.error(
          `Too many ${schema.rowNounPlural} to count in time. Narrow the time range or pick a device to get a total.`,
        );
      }
    } catch {
      if (current === generation.current) {
        toast.error(`Could not count the ${schema.rowNounPlural}.`);
      }
    } finally {
      if (current === generation.current) setCounting(false);
    }
  }, [filterParams, schema.rowNounPlural]);

  // The devices the filter can offer. Refetched on Refresh, so a device that
  // sends its first payload shows up without reloading the page.
  const fetchDevices = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/payloads/devices?${ENVIRONMENT_PARAM}=${encodeURIComponent(environment.name)}`,
        { cache: "no-store" },
      );
      const result = await response.json();
      if (result.success) {
        setDevices(result.devices ?? []);
        setDevicesWithoutUid(Boolean(result.withoutUid));
      }
    } catch {
      // The list is a convenience; the table still works without it.
    }
  }, [environment.name]);

  useEffect(() => {
    if (firstPageLoaded) fetchDevices();
  }, [fetchDevices, firstPageLoaded]);

  // Any change to the filter reloads the first batch (fetchPayloads depends on
  // it), so the rows shown always belong to the current filter.
  const changeFrom = useCallback((value: string) => setFrom(value), []);
  const changeTo = useCallback((value: string) => setTo(value), []);

  const changeDevice = useCallback((value: string) => {
    setDeviceUid(value);
    // The inspected payload may belong to another device.
    setSelectedId(null);
  }, []);

  const clearFilter = useCallback(() => {
    setFrom("");
    setTo("");
    setDeviceUid("");
  }, []);

  // Fetch every payload in the current range (all pages), most-recent first.
  const fetchAllInRange = useCallback(async (): Promise<PayloadRow[]> => {
    // Time windows walked newest → oldest, cursor pages whose size adapts to
    // the database timeout, empty periods skipped, merged into one result
    // (lib/payload-export).
    const fromBound = createdAtBoundFromInput(from, "from");
    const toBound = createdAtBoundFromInput(to, "to");
    return exportRange<PayloadRow>({
      from: fromBound ? new Date(fromBound) : null,
      to: toBound ? new Date(toBound) : null,
      receivedKey: schema.receivedKey,
      primaryKey: schema.primaryKey,
      fetchPage: async (request) => {
        const params = new URLSearchParams({
          limit: String(request.limit),
          count: "none",
          to: request.to,
        });
        if (request.from) params.set("from", request.from);
        if (deviceUid) params.set("device_uid", deviceUid);
        params.set(ENVIRONMENT_PARAM, environment.name);
        if (request.cursor) {
          params.set("before", request.cursor.before);
          params.set("before_id", request.cursor.beforeId);
        }
        const response = await fetch(`/api/payloads?${params.toString()}`, {
          cache: "no-store",
        });
        const result = await response.json().catch(() => ({ success: false }));
        if (!result.success) {
          throw new Error(result.details ?? result.error ?? `HTTP ${response.status}`);
        }
        return { data: result.data ?? [], next_cursor: result.next_cursor ?? null };
      },
      onProgress: ({ rows: count, reached }) => {
        setExportedRows(count);
        setExportReached(reached);
      },
    });
  }, [from, to, deviceUid, environment.name, schema]);

  // The CSV carries exactly the table's columns, in the table's order.
  const csvColumns = useMemo(
    () =>
      columnsView.selected
        .map((key) => schema.csvColumns.find((column) => column.key === key))
        .filter((column): column is NonNullable<typeof column> => column !== undefined),
    [schema, columnsView.selected],
  );

  // Gather the full range and download it as CSV, with the table's columns.
  const handleDownloadCsv = useCallback(async () => {
    setExporting(true);
    setExportedRows(0);
    setExportReached(null);
    try {
      const data = await fetchAllInRange();
      if (data.length === 0) {
        toast.error(
          `No ${schema.rowNounPlural} to download in the selected range.`,
        );
        return;
      }
      const csv = buildCsv(data, csvColumns);
      const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-");
      downloadCsv(csv, `${schema.csvBasename}-${stamp}.csv`);
      toast.success(`Downloaded ${data.length} ${schema.rowNoun}(s).`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : `Could not export ${schema.rowNounPlural}.`,
      );
    } finally {
      setExporting(false);
    }
  }, [fetchAllInRange, csvColumns, schema]);

  const hasFilter = from !== "" || to !== "" || deviceUid !== "";
  const hasMore = cursor !== null;

  const selectedIndex = rows.findIndex((row) => rowId(row) === selectedId);
  const selected = selectedIndex === -1 ? null : rows[selectedIndex];

  // Only a dataset that stores the raw frame can be inspected byte by byte;
  // the others are already decoded and are rendered from their schema instead.
  const selectedAnalysis = useMemo(
    () =>
      selected && schema.capabilities.rawPayloadInspector
        ? safeAnalyze((selected as PayloadRecord).payload_hex)
        : null,
    [selected, schema.capabilities.rawPayloadInspector],
  );

  // Position of the selection among the rows loaded (newest first). Every
  // newer row is always loaded, so this is also its position in the filter.
  const selectedNumber = selectedIndex + 1;
  const hasNewer = selectedIndex > 0;
  const hasOlder = selectedIndex !== -1 && (selectedIndex < rows.length - 1 || hasMore);

  // Step through the payloads one at a time. Stepping "Older" past the last
  // loaded row loads the next batch and lands on its first row, so the
  // inspector can walk every stored payload in the range.
  const stepSelection = useCallback(
    (delta: 1 | -1) => {
      if (selectedIndex === -1) return;
      const next = rows[selectedIndex + delta];
      if (next) {
        setSelectedId(rowId(next));
      } else if (delta === 1 && hasMore) {
        loadMore(true);
      }
    },
    [rows, selectedIndex, rowId, hasMore, loadMore],
  );

  return (
    <div className="space-y-6">
      {/* This filter scopes the table below. The charts carry their own
          independent time range so previous data can be viewed on them alone,
          but they follow the device filter: mixing devices in one battery or
          coverage line would be meaningless. */}
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
          {schema.capabilities.deviceFilter && (
          <div className="grid gap-1.5">
            <Label htmlFor="device-uid" className="text-xs text-muted-foreground">
              Device
            </Label>
            <select
              id="device-uid"
              value={deviceUid}
              onChange={(e) => changeDevice(e.target.value)}
              className="h-9 min-w-56 rounded-md border border-input bg-transparent px-3 py-1 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="">All devices</option>
              {devices.map((device) => (
                <option key={device.device_uid} value={device.device_uid}>
                  {device.device_uid} ({device.payloads})
                </option>
              ))}
              {/* V0 payloads carry no UID; offered only when some exist. */}
              {devicesWithoutUid && (
                <option value={NO_DEVICE_UID}>No UID (V0)</option>
              )}
              {/* Keep a selected device listed even if a refresh no longer
                  returns it, so the control never shows a value it lacks. */}
              {deviceUid !== "" &&
                deviceUid !== NO_DEVICE_UID &&
                !devices.some((d) => d.device_uid === deviceUid) && (
                  <option value={deviceUid}>{deviceUid}</option>
                )}
            </select>
          </div>
          )}
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
              fetchDevices();
              setRefreshKey((k) => k + 1);
            }}
            className="ml-auto gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </CardContent>
      </Card>

      <LazyMount
        ready={firstPageLoaded}
        placeholder={<SectionPlaceholder label="Charts load after the table…" />}
      >
        <PayloadCharts refreshKey={refreshKey} deviceUid={deviceUid} />
      </LazyMount>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            <span>
              Received <span className="lowercase">{schema.rowNounPlural}</span>
            </span>
            <span className="font-mono text-xs font-normal text-muted-foreground">
              {schema.table}
            </span>
          </CardTitle>
          <CardAction>
            <div className="flex flex-wrap items-center gap-2">
              <ViewPicker
                trigger={
                  <>
                    <Columns3 className="h-4 w-4" />
                    Columns
                  </>
                }
                title="Table columns"
                items={schema.fields.map((field) => ({
                  key: field.key,
                  label: fieldLabel(field),
                  group: field.group,
                }))}
                selected={columnsView.selected}
                onToggle={columnsView.toggle}
                onSelectAll={() => columnsView.setSelected(fieldKeys)}
                onClear={() => columnsView.setSelected([])}
                onSave={columnsView.save}
                onReset={columnsView.reset}
                unsaved={columnsView.unsaved}
                hasSavedView={columnsView.hasSavedView}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadCsv}
                disabled={exporting || csvColumns.length === 0}
                title="Downloads the columns shown in the table"
                className="gap-2"
              >
                <Download className="h-4 w-4" />
                {exporting
                  ? `Exporting… ${exportedRows.toLocaleString()} rows${exportReached ? ` · back to ${exportReached.toISOString().slice(0, 10)}` : ""}`
                  : "Download CSV"}
              </Button>
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
                No {schema.rowNounPlural} match the selected filter.
              </p>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No {schema.rowNounPlural} stored in{" "}
                <span className="font-mono">{schema.table}</span> yet. Send a
                payload to <span className="font-mono">POST /api/payloads</span>{" "}
                or use the Playground.
              </p>
            )
          ) : (
            <>
              {/* Columns, labels and units all come from the active schema,
                  so one table renders either environment's rows. */}
              <Table>
                <TableHeader>
                  <TableRow>
                    {listFields.map((field) => (
                      <TableHead
                        key={field.key}
                        className={isNumericField(field) ? "text-right" : undefined}
                      >
                        {fieldLabel(field)}
                      </TableHead>
                    ))}
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const id = rowId(row);
                    return (
                      <TableRow
                        key={id}
                        data-state={id === selectedId ? "selected" : undefined}
                      >
                        {listFields.map((field) => (
                          <TableCell
                            key={field.key}
                            className={
                              isNumericField(field) ? "text-right" : undefined
                            }
                          >
                            <PayloadCell row={row} field={field} />
                          </TableCell>
                        ))}
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setSelectedId((prev) => (prev === id ? null : id))
                            }
                          >
                            {selectedId === id ? "Hide" : "Inspect"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Showing the{" "}
                  <span className="font-mono">{rows.length.toLocaleString()}</span>{" "}
                  most recent {schema.rowNoun}(s)
                  {total !== null && (
                    <>
                      {" "}of{" "}
                      <span className="font-mono">{total.toLocaleString()}</span>
                    </>
                  )}
                  {hasFilter ? " in the selected filter" : ""}
                  {!hasMore && " · all loaded"}
                </p>
                <div className="flex items-center gap-2">
                  {total === null && hasMore && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={countTotal}
                      disabled={counting}
                      title={
                        hasFilter
                          ? "Count every row in the filter"
                          : "Counting a large table can time out; a time range or a device makes it fast"
                      }
                      className="gap-2"
                    >
                      <Hash className="h-4 w-4" />
                      {counting ? "Counting…" : "Count total"}
                    </Button>
                  )}
                  {hasMore && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => loadMore()}
                      disabled={loadingMore}
                      className="gap-2"
                    >
                      <ChevronDown className="h-4 w-4" />
                      {loadingMore
                        ? "Loading…"
                        : `Load ${nextBatchSize(batchesLoaded)} more`}
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 capitalize">
              <Database className="h-4 w-4 text-primary" />
              {schema.rowNoun}{" "}
              <span className="font-normal normal-case">
                {formatCreatedAt(
                  String(columnValue(selected, schema.receivedKey)),
                )}
              </span>
            </CardTitle>
            <CardAction>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  <span className="font-mono">{selectedNumber}</span> of{" "}
                  <span className="font-mono">
                    {total ?? `${rows.length}${hasMore ? "+" : ""}`}
                  </span>
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
                  disabled={!hasOlder || loading || loadingMore}
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
            {schema.capabilities.rawPayloadInspector ? (
              selectedAnalysis ? (
                <PayloadAnalysisView analysis={selectedAnalysis} />
              ) : (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  This payload could not be decoded from its stored hex.
                </p>
              )
            ) : (
              <PayloadRecordView row={selected} schema={schema} />
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
