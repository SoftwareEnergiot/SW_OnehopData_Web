"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  RefreshCw,
  Save,
  Settings2,
  XCircle,
} from "lucide-react";

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useActiveEnvironment } from "@/components/environment-provider";
import { ENVIRONMENT_PARAM } from "@/lib/environments";
import { formatCreatedAt, cn } from "@/lib/utils";
import {
  CONFIG_V0_TEMPLATE,
  CONFIG_VERSIONS,
  buildConfigFileV0,
  deriveConfigState,
  describePollStatus,
  formatCrc32,
  formatDuration,
  intervalLimits,
  isPollStatusProblem,
  parseConfigJson,
  pollingTargetWarnings,
  validateConfigV0,
  type ConfigFieldError,
  type ConfigState,
  type ConfigVersion,
  type RemoteConfigV0,
} from "@/lib/remote-config";

// One saved `device_config` row, as GET /api/remote-config returns it.
interface SavedConfig {
  device_uid: string;
  config_version: number;
  config: RemoteConfigV0;
  lab_limits: boolean;
  file: string;
  crc32: string;
  updated_at: string;
}

// One device of GET /api/remote-config.
interface DeviceRow {
  /** "00:12:4B:…" */
  device_uid: string;
  /** The UID as the environment's table stores it. */
  stored_uid: string;
  payloads: number;
  last_seen: string;
  last_report: {
    received_at: string;
    config_crc32: number | null;
    last_poll_status: number | null;
  } | null;
  config: SavedConfig | null;
}

// What each line of the v0 file carries, shown beside the preview.
const FILE_LINE_LABELS = [
  "version",
  "reporting_url",
  "reporting_path",
  "polling_url",
  "polling_path",
  "apn",
  "api_key (empty: keep the key)",
  "reporting_interval_ms",
  "polling_interval_ms",
  "CRC32",
];

const STATE_LABEL: Record<ConfigState, string> = {
  applied: "Applied",
  pending: "Pending",
  none: "No remote config",
};

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function editorTextFor(config: RemoteConfigV0): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function StateBadge({ state }: { state: ConfigState }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        state === "applied" && "border-emerald-300 bg-emerald-50 text-emerald-800",
        state === "pending" && "border-amber-300 bg-amber-50 text-amber-800",
        state === "none" && "text-muted-foreground",
      )}
    >
      {STATE_LABEL[state]}
    </Badge>
  );
}

function PollStatus({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn(isPollStatusProblem(value) && "text-destructive")}>
      <span className="font-mono">{value}</span>
      <span className="text-muted-foreground"> · </span>
      {describePollStatus(value)}
    </span>
  );
}

function noSubscription() {
  return () => {};
}

function crcOrDash(value: number | null | undefined) {
  return value == null ? "—" : formatCrc32(value);
}

export function RemoteConfig() {
  const { environment } = useActiveEnvironment();

  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const [selectedUid, setSelectedUid] = useState("");
  const [version, setVersion] = useState<ConfigVersion>("v0");
  const [editorText, setEditorText] = useState("");
  // What the editor was last filled with, to tell unsaved edits apart.
  const [loadedText, setLoadedText] = useState("");
  const [labLimits, setLabLimits] = useState(false);
  const [loadedLabLimits, setLoadedLabLimits] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState<ConfigFieldError[]>([]);

  const selected = useMemo(
    () => devices.find((d) => d.device_uid === selectedUid) ?? null,
    [devices, selectedUid],
  );

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/remote-config?${ENVIRONMENT_PARAM}=${encodeURIComponent(environment.name)}`,
        { cache: "no-store" },
      );
      const result = await response.json();
      if (!result.success) {
        setLoadError(result.details ?? result.error ?? "Failed to load remote configs");
        setDevices([]);
        return;
      }
      setLoadError(null);
      setDevices(result.devices ?? []);
      setTruncated(Boolean(result.truncated));
    } catch {
      setLoadError("Could not load remote configs (is Supabase configured?)");
    } finally {
      setLoading(false);
    }
  }, [environment.name]);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  // Fill the editor with a device's saved config, or the template.
  const fillEditor = useCallback((device: DeviceRow | null) => {
    const text = editorTextFor(device?.config?.config ?? CONFIG_V0_TEMPLATE);
    const lab = device?.config?.lab_limits ?? false;
    setEditorText(text);
    setLoadedText(text);
    setLabLimits(lab);
    setLoadedLabLimits(lab);
    setConfirming(false);
    setServerErrors([]);
  }, []);

  const dirty = editorText !== loadedText || labLimits !== loadedLabLimits;

  function selectDevice(uid: string) {
    if (uid === selectedUid) return;
    if (dirty && !window.confirm("Discard the unsaved edits to this config?")) return;
    setSelectedUid(uid);
    fillEditor(devices.find((d) => d.device_uid === uid) ?? null);
  }

  // Live validation, exactly the rules the server (and the firmware) applies.
  const parsed = useMemo(() => parseConfigJson(editorText), [editorText]);
  const validation = useMemo(
    () => (parsed.ok ? validateConfigV0(parsed.value, { labLimits }) : null),
    [parsed, labLimits],
  );
  const file = useMemo(
    () => (validation?.ok ? buildConfigFileV0(validation.config) : null),
    [validation],
  );

  // Where this application is served from, to warn about a polling target
  // that points elsewhere. Never changes while the page is open.
  const appHostname = useSyncExternalStore(
    noSubscription,
    () => window.location.hostname,
    () => "",
  );
  const pollingWarnings = useMemo(
    () =>
      validation?.ok && appHostname
        ? pollingTargetWarnings(validation.config, appHostname)
        : [],
    [validation, appHostname],
  );

  const lastCrc = selected?.last_report?.config_crc32 ?? null;
  const deviceRunsThis = file !== null && lastCrc !== null && lastCrc >>> 0 === file.crc32;
  const selectedState = selected
    ? deriveConfigState(selected.config?.crc32, lastCrc)
    : null;
  const limits = intervalLimits(labLimits);

  async function save() {
    if (!selected || !validation?.ok) return;
    setSaving(true);
    setServerErrors([]);
    try {
      const response = await fetch(
        `/api/remote-config/${selected.device_uid.replace(/:/g, "")}?${ENVIRONMENT_PARAM}=${encodeURIComponent(environment.name)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version,
            config: validation.config,
            lab_limits: labLimits,
          }),
        },
      );
      const result = await response.json();
      if (!result.success) {
        setServerErrors(result.errors ?? []);
        toast.error(result.details ?? result.error ?? "Failed to save the config");
        return;
      }
      const saved = result.config as SavedConfig;
      setDevices((rows) =>
        rows.map((row) =>
          row.device_uid === selected.device_uid ? { ...row, config: saved } : row,
        ),
      );
      const text = editorTextFor(saved.config);
      setEditorText(text);
      setLoadedText(text);
      setLoadedLabLimits(saved.lab_limits);
      setConfirming(false);
      toast.success(
        `Config ${saved.crc32} saved for ${selected.device_uid}. It reaches the device on its next poll.`,
      );
    } catch {
      toast.error("Could not reach the server to save the config.");
    } finally {
      setSaving(false);
    }
  }

  const clientErrors: ConfigFieldError[] = !parsed.ok
    ? [{ field: null, message: `Invalid JSON: ${parsed.message}` }]
    : validation && !validation.ok
      ? validation.errors
      : [];
  const errors = clientErrors.length > 0 ? clientErrors : serverErrors;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-primary" />
            Remote config
          </CardTitle>
          <CardDescription>
            The file each device downloads from{" "}
            <span className="font-mono">GET /api/config</span> on its next poll.
            Devices without a saved config get 204 and keep their own.
          </CardDescription>
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchDevices}
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
              <Label htmlFor="rc-device" className="text-xs text-muted-foreground">
                Device
              </Label>
              <select
                id="rc-device"
                value={selectedUid}
                onChange={(e) => selectDevice(e.target.value)}
                className={cn(SELECT_CLASS, "min-w-64 font-mono")}
              >
                <option value="" disabled>
                  {devices.length === 0 ? "No devices have reported" : "Select a device"}
                </option>
                {devices.map((device) => (
                  <option key={device.device_uid} value={device.device_uid}>
                    {device.device_uid}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rc-version" className="text-xs text-muted-foreground">
                Config version
              </Label>
              <select
                id="rc-version"
                value={version}
                onChange={(e) => {
                  setVersion(e.target.value as ConfigVersion);
                  fillEditor(selected);
                }}
                className={cn(SELECT_CLASS, "font-mono")}
              >
                {CONFIG_VERSIONS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            {selected && selectedState && (
              <div className="flex flex-wrap items-center gap-2 pb-2 text-xs text-muted-foreground">
                <StateBadge state={selectedState} />
                {selected.config ? (
                  <span>
                    saved {formatCreatedAt(selected.config.updated_at)} · CRC{" "}
                    <span className="font-mono">{selected.config.crc32}</span>
                  </span>
                ) : (
                  <span>no saved config — the editor shows the template</span>
                )}
              </div>
            )}
          </div>

          {!selected ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {loading
                ? "Loading…"
                : loadError
                  ? loadError
                  : "Pick a device, or a row of the table below, to edit its config."}
            </p>
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-3">
                <Label htmlFor="rc-editor" className="text-xs text-muted-foreground">
                  Config (JSON)
                </Label>
                <Textarea
                  id="rc-editor"
                  value={editorText}
                  onChange={(e) => {
                    setEditorText(e.target.value);
                    setConfirming(false);
                    setServerErrors([]);
                  }}
                  spellCheck={false}
                  aria-invalid={errors.length > 0}
                  className="min-h-64 font-mono text-xs md:text-xs"
                />

                {errors.length > 0 ? (
                  <ul className="space-y-1 text-xs text-destructive">
                    {errors.map((error, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          {error.field && (
                            <span className="font-mono font-medium">{error.field} </span>
                          )}
                          {error.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="flex items-center gap-1.5 text-xs text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Valid for the firmware
                    {labLimits ? " (lab limits)" : ""}.
                  </p>
                )}

                <p className="text-xs text-muted-foreground">
                  Intervals: reporting {formatDuration(limits.reporting.min)} –{" "}
                  {formatDuration(limits.reporting.max)}, polling{" "}
                  {formatDuration(limits.polling.min)} –{" "}
                  {formatDuration(limits.polling.max)}.
                </p>

                <div className="space-y-2 rounded-md border border-border p-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={labLimits}
                      onChange={(e) => {
                        setLabLimits(e.target.checked);
                        setConfirming(false);
                      }}
                      className="h-4 w-4"
                    />
                    <FlaskConical className="h-4 w-4 text-muted-foreground" />
                    Lab limits (Debug firmware)
                  </label>
                  {labLimits && (
                    <p className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      Bench testing only. Both intervals may go down to 1 s, which
                      only Debug firmware accepts: release firmware rejects the
                      file (poll status 7), and short intervals drain the battery.
                    </p>
                  )}
                </div>

                {pollingWarnings.length > 0 && (
                  <div className="space-y-1 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
                    {pollingWarnings.map((warning) => (
                      <p key={warning} className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {warning}
                      </p>
                    ))}
                    <p className="pl-5">
                      The device polls there from now on. A wrong value leaves it
                      without polling until the file fails its trial and reverts.
                    </p>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">
                    File sent to the device
                  </Label>
                  {file && (
                    <span className="text-xs text-muted-foreground">
                      {file.bytes.length} bytes · CRC{" "}
                      <span className="font-mono font-medium text-foreground">
                        {file.crc32Hex}
                      </span>
                    </span>
                  )}
                </div>
                {file ? (
                  <div className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">
                    <table className="w-full">
                      <tbody>
                        {file.text
                          .slice(0, -1)
                          .split("\n")
                          .map((line, i) => (
                            <tr key={i}>
                              <td className="select-none pr-3 text-right align-top text-muted-foreground">
                                {i + 1}
                              </td>
                              <td className="whitespace-pre pr-6 align-top">
                                {line}
                                <span className="select-none text-muted-foreground/60">↵</span>
                              </td>
                              <td className="select-none whitespace-nowrap text-right align-top font-sans text-muted-foreground">
                                {FILE_LINE_LABELS[i]}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                    Fix the errors to see the file.
                  </p>
                )}

                {deviceRunsThis && (
                  <p className="flex items-center gap-1.5 text-xs text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    The device already runs this config (its last payload reports
                    CRC {file.crc32Hex}).
                  </p>
                )}

                {selected.last_report && (
                  <p className="text-xs text-muted-foreground">
                    Last payload {formatCreatedAt(selected.last_report.received_at)}:
                    config CRC{" "}
                    <span className="font-mono">
                      {crcOrDash(selected.last_report.config_crc32)}
                    </span>
                    , poll status{" "}
                    <PollStatus value={selected.last_report.last_poll_status} />.
                  </p>
                )}

                {confirming ? (
                  <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
                    <p>
                      Save config{" "}
                      <span className="font-mono font-medium">{file?.crc32Hex}</span>{" "}
                      for <span className="font-mono">{selected.device_uid}</span>?
                      It replaces the device&apos;s current saved config.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Nothing changes on the device now: it downloads the file on
                      its next poll, up to one polling interval away, tries it,
                      and confirms it after one good report and poll.
                    </p>
                    {pollingWarnings.length > 0 && (
                      <p className="text-xs font-medium text-amber-900">
                        The polling target is not this application.
                      </p>
                    )}
                    <div className="flex gap-2">
                      <Button size="sm" onClick={save} disabled={saving} className="gap-2">
                        <Save className="h-4 w-4" />
                        {saving ? "Saving…" : "Confirm and save"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirming(false)}
                        disabled={saving}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <Button
                      onClick={() => setConfirming(true)}
                      disabled={!file}
                      className="gap-2"
                    >
                      <Save className="h-4 w-4" />
                      Save config
                    </Button>
                    {dirty && (
                      <span className="text-xs text-muted-foreground">Unsaved edits</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Devices</CardTitle>
          <CardDescription>
            Every device that has reported to {environment.name}. Applied means
            the last payload&apos;s config CRC is the saved file&apos;s; a file that
            fails its trial is reverted (poll status 8) and shows as Pending again.
            {truncated && " Only the most recent payloads were scanned; older devices may be missing."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : loadError ? (
            <p className="py-8 text-center text-sm text-destructive">{loadError}</p>
          ) : devices.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No device has sent a payload to this environment yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Saved config</TableHead>
                  <TableHead>File CRC</TableHead>
                  <TableHead>Reported CRC</TableHead>
                  <TableHead>Last poll status</TableHead>
                  <TableHead>Last payload</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((device) => {
                  const state = deriveConfigState(
                    device.config?.crc32,
                    device.last_report?.config_crc32,
                  );
                  return (
                    <TableRow
                      key={device.device_uid}
                      onClick={() => selectDevice(device.device_uid)}
                      data-state={device.device_uid === selectedUid ? "selected" : undefined}
                      className="cursor-pointer"
                    >
                      <TableCell className="font-mono text-xs">{device.device_uid}</TableCell>
                      <TableCell>
                        <StateBadge state={state} />
                      </TableCell>
                      <TableCell className="text-xs">
                        {device.config ? (
                          <>
                            Yes · {formatCreatedAt(device.config.updated_at)}
                            {device.config.lab_limits && (
                              <Badge variant="outline" className="ml-2 border-amber-300 text-amber-800">
                                lab
                              </Badge>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">No</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {device.config?.crc32 ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {crcOrDash(device.last_report?.config_crc32)}
                      </TableCell>
                      <TableCell className="text-xs">
                        <PollStatus value={device.last_report?.last_poll_status} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {device.last_report
                          ? formatCreatedAt(device.last_report.received_at)
                          : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
