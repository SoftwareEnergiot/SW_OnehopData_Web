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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PayloadAnalysisView } from "@/components/payload-analysis";
import { PayloadRecordView } from "@/components/payload-record-view";
import { PayloadCharts } from "@/components/payload-charts";
import { PayloadCell, isNumericField } from "@/components/payload-cell";
import { useActiveEnvironment } from "@/components/environment-provider";
import { useSavedView } from "@/components/use-saved-view";
import { ViewPicker } from "@/components/view-picker";
import { analyzePayload, hexToBytes } from "@/lib/payload-decoder";
import { createdAtBoundFromInput, formatCreatedAt } from "@/lib/utils";
import { buildCsv, downloadCsv } from "@/lib/payload-csv";
import { NO_DEVICE_UID } from "@/lib/payload-filters";
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
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Columns3,
  Database,
  Download,
  RefreshCw,
  SlidersHorizontal,
  X,
} from "lucide-react";

const PAGE_SIZES = [25, 50, 100, 200];

// Rows pulled per request when gathering a full range for CSV export. Kept at
// or below the Supabase default row cap so a single page never silently drops
// rows off the end.
const EXPORT_CHUNK = 1000;

export function ReceivedPayloads() {
  // The dataset this view reads. Guaranteed present: the dashboard only
  // renders behind <EnvironmentGuard>.
  const { environment, schema } = useActiveEnvironment();

  // Every CSV column the active schema offers, used to seed "all selected".
  const allColumnKeys = useMemo(
    () => schema.csvColumns.map((column) => column.key),
    [schema],
  );

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

  const [rows, setRows] = useState<PayloadRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
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
  // Paging through every stored payload in the selected range.
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  // Set when the inspector steps past the edge of the current page: once the
  // next page has loaded, select its first ("first") or last ("last") row so
  // navigation continues seamlessly across the whole range.
  const [selectEdge, setSelectEdge] = useState<"first" | "last" | null>(null);
  // Bumped by Refresh so the charts refetch alongside the table.
  const [refreshKey, setRefreshKey] = useState(0);
  // Columns included in a CSV export, keyed by CSV_COLUMNS[].key. All start
  // selected; the picker never lets the set fall to empty.
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(
    () => new Set(schema.csvColumns.map((column) => column.key)),
  );
  // True while a CSV export is gathering rows, to disable the button and show
  // progress.
  const [exporting, setExporting] = useState(false);

  const fetchPayloads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(page * pageSize),
      });
      const fromBound = createdAtBoundFromInput(from, "from");
      if (fromBound) params.set("from", fromBound);
      const toBound = createdAtBoundFromInput(to, "to");
      if (toBound) params.set("to", toBound);
      if (deviceUid) params.set("device_uid", deviceUid);
      // Named on every request, so a row can only ever come from the active
      // environment's table.
      params.set(ENVIRONMENT_PARAM, environment.name);

      const response = await fetch(`/api/payloads?${params.toString()}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (result.success) {
        setRows(result.data ?? []);
        setTotal(result.total ?? 0);
      } else {
        toast.error(result.details ?? result.error ?? "Failed to load payloads");
      }
    } catch {
      // The list needs Supabase configured; fail quietly with a hint.
      toast.error("Could not load stored payloads (is Supabase configured?)");
    } finally {
      setLoading(false);
    }
  }, [from, to, deviceUid, page, pageSize, environment.name]);

  useEffect(() => {
    fetchPayloads();
  }, [fetchPayloads]);

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
    fetchDevices();
  }, [fetchDevices]);

  // A row's identity, read through the schema's primary key.
  const rowId = useCallback(
    (row: PayloadRow) => String(columnValue(row, schema.primaryKey)),
    [schema.primaryKey],
  );

  // Land on the requested edge of a page the inspector just navigated into.
  useEffect(() => {
    if (!selectEdge || rows.length === 0) return;
    const row = selectEdge === "first" ? rows[0] : rows[rows.length - 1];
    setSelectedId(rowId(row));
    setSelectEdge(null);
  }, [rows, selectEdge, rowId]);

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

  const changeDevice = useCallback((value: string) => {
    setDeviceUid(value);
    setPage(0);
    // The inspected payload may belong to another device.
    setSelectedId(null);
  }, []);

  const changePageSize = useCallback((value: number) => {
    setPageSize(value);
    setPage(0);
  }, []);

  const clearFilter = useCallback(() => {
    setFrom("");
    setTo("");
    setDeviceUid("");
    setPage(0);
  }, []);

  // Toggle one column. The last remaining column cannot be turned off, so the
  // export always carries at least one field.
  const toggleColumn = useCallback((key: string) => {
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size === 1) return prev;
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const selectAllColumns = useCallback(() => {
    setSelectedColumns(new Set(allColumnKeys));
  }, [allColumnKeys]);

  // "Deselect all" keeps the first column selected — an export needs at least
  // one field, and this leaves an obvious one to build back up from.
  const deselectAllColumns = useCallback(() => {
    setSelectedColumns(new Set([allColumnKeys[0]]));
  }, [allColumnKeys]);

  // Fetch every payload in the current range (all pages), most-recent first.
  const fetchAllInRange = useCallback(async (): Promise<PayloadRow[]> => {
    const all: PayloadRow[] = [];
    let offset = 0;
    for (;;) {
      const params = new URLSearchParams({
        limit: String(EXPORT_CHUNK),
        offset: String(offset),
      });
      const fromBound = createdAtBoundFromInput(from, "from");
      if (fromBound) params.set("from", fromBound);
      const toBound = createdAtBoundFromInput(to, "to");
      if (toBound) params.set("to", toBound);
      if (deviceUid) params.set("device_uid", deviceUid);
      params.set(ENVIRONMENT_PARAM, environment.name);

      const response = await fetch(`/api/payloads?${params.toString()}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!result.success) {
        throw new Error(result.details ?? result.error ?? "Failed to load payloads");
      }
      const batch: PayloadRow[] = result.data ?? [];
      all.push(...batch);
      const count: number = result.total ?? all.length;
      // Stop once we've collected the reported total, or a short page signals
      // the end (guards against a total that lags behind the data).
      if (all.length >= count || batch.length < EXPORT_CHUNK) break;
      offset += EXPORT_CHUNK;
    }
    return all;
  }, [from, to, deviceUid, environment.name]);

  // Gather the full range and download it as CSV using the selected columns.
  const handleDownloadCsv = useCallback(async () => {
    setExporting(true);
    try {
      const data = await fetchAllInRange();
      if (data.length === 0) {
        toast.error(
          `No ${schema.rowNounPlural} to download in the selected range.`,
        );
        return;
      }
      // The active schema's columns, so an export always describes the table
      // it was read from.
      const csv = buildCsv(data, selectedColumns, schema.csvColumns);
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
  }, [fetchAllInRange, selectedColumns, schema]);

  const hasFilter = from !== "" || to !== "" || deviceUid !== "";
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const firstRowNumber = total === 0 ? 0 : page * pageSize + 1;
  const lastRowNumber = page * pageSize + rows.length;

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
        setSelectedId(rowId(next));
      } else if (delta === 1 && page < pageCount - 1) {
        setSelectEdge("first");
        setPage((p) => p + 1);
      } else if (delta === -1 && page > 0) {
        setSelectEdge("last");
        setPage((p) => p - 1);
      }
    },
    [rows, selectedIndex, page, pageCount, rowId],
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

      <PayloadCharts refreshKey={refreshKey} deviceUid={deviceUid} />

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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2">
                    <SlidersHorizontal className="h-4 w-4" />
                    CSV columns
                    <span className="text-xs text-muted-foreground">
                      ({selectedColumns.size}/{schema.csvColumns.length})
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>CSV columns</DropdownMenuLabel>
                  <div className="flex gap-1 px-1 py-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 flex-1"
                      onClick={selectAllColumns}
                    >
                      Select all
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 flex-1"
                      onClick={deselectAllColumns}
                    >
                      Deselect all
                    </Button>
                  </div>
                  <DropdownMenuSeparator />
                  {schema.csvColumns.map((column) => {
                    const checked = selectedColumns.has(column.key);
                    const isLast = checked && selectedColumns.size === 1;
                    return (
                      <DropdownMenuCheckboxItem
                        key={column.key}
                        checked={checked}
                        disabled={isLast}
                        // Keep the menu open so several columns can be toggled
                        // in one pass.
                        onSelect={(e) => e.preventDefault()}
                        onCheckedChange={() => toggleColumn(column.key)}
                      >
                        {column.label}
                      </DropdownMenuCheckboxItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadCsv}
                disabled={exporting}
                className="gap-2"
              >
                <Download className="h-4 w-4" />
                {exporting ? "Exporting…" : "Download CSV"}
              </Button>
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
                  Showing{" "}
                  <span className="font-mono">
                    {firstRowNumber}–{lastRowNumber}
                  </span>{" "}
                  of <span className="font-mono">{total}</span>{" "}
                  {schema.rowNoun}(s)
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
