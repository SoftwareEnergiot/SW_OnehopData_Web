# Onehop Payload Platform

Testing platform for Onehop devices: receive, decode, store, and inspect their
**binary uplink payloads**.

Devices `POST` a raw binary payload to an HTTP endpoint. The server decodes it,
stores both the raw and decoded forms in Supabase, and the dashboard renders a
binary-vs-hexadecimal comparison plus a full field-by-field deconstruction
(header, samples, batch context, and error mask).

Two formats are supported, dispatched on the **version byte at offset 0**:

| Version | Document | Total length | Device UID |
| ------- | -------- | ------------ | ---------- |
| **V1** (current) | [Confluence — V1](https://energiot.atlassian.net/wiki/spaces/WSNFD/pages/670793729/V1) | 93 bytes | yes |
| **V0** (legacy)  | *Payload Encode - LoraWAN V0* | `10 + 28 · N` bytes | no |

**Only the current V1 (93 bytes, with device UID) is accepted for storage.** A
frame in any other format — V0, or the earlier 82/86-byte V1 revisions —
still decodes (so stored rows and the Playground can show it) but is
discarded with a `400`. Every stored payload therefore carries a device UID.

It is built with the same stack and conventions as the reference Sensor Data
Platform: **Next.js (App Router) + TypeScript (strict) + Tailwind CSS v4 +
shadcn/ui + Supabase**, tested with **Vitest**.

---

## Environments

After signing in, the user picks the **environment** the session will operate
in. The environment decides which payload dataset the whole application reads
and writes — every table, chart, filter, export and write follows it.

| Environment   | `public.environment.production` | Payload table          | One row is |
| ------------- | ------------------------------- | ---------------------- | ---------- |
| `REE`         | `true` → shown as *Production*  | `public."payloads_REE"` | one decoded sample |
| `Development` | `false` → shown as *Development* | `public.payloads`      | one whole received frame |

The list on the selector comes **only** from `public.environment` — the
frontend carries no copy of it. The mapping from an environment to its table
lives in one place, `ENVIRONMENT_CONFIG` in [`lib/environments.ts`](lib/environments.ts);
no component ever compares an environment name itself.

**The flow:**

```
Sign in  →  /select-environment  →  /  (dashboard)
```

- `NEXT_PUBLIC_CLERK_SIGN_IN_FORCE_REDIRECT_URL` lands a fresh sign-in on
  `/select-environment`.
- The choice is kept in **`sessionStorage`**, so it survives a refresh but
  belongs to the browsing session rather than to the browser. A shared machine
  never inherits someone else's production context.
- On every load the persisted choice is re-validated against
  `public.environment`. One that the table no longer offers is **cleared**, not
  swapped for another — and the reader goes back to the selector.
- `/` is wrapped in `<EnvironmentGuard>`: without a valid environment it
  redirects to `/select-environment` rather than loading payloads.
- Switching environments remounts the dashboard, so no value from the previous
  one can survive the switch.
- Logging out clears the environment along with the session.

Reach the selector again from the user menu → **Change environment**.

### What each environment can do

The two tables hold genuinely different things, so the dashboard is driven by a
schema descriptor per dataset ([`lib/payload-schemas.ts`](lib/payload-schemas.ts))
rather than duplicated: columns, labels, units, groups, chartable series, CSV
columns and capabilities all come from there, and one set of components renders
either environment.

| Feature | `Development` | `REE` |
| ------- | ------------- | ----- |
| List, paging, time range, device filter, refresh | yes | yes |
| CSV export | yes | yes, REE columns |
| Reception-frequency and frame-counter charts | yes | yes |
| Detail inspector | binary-vs-hex + field-by-field decode of the stored frame | field-by-field from the stored columns: sensors, batch context, error mask and valid-sample mask |
| Payload-size chart | yes | no — `payloads_REE` has no `byte_length` |
| Battery / coverage charts | yes | yes |
| Table columns: pick any column, save the view | yes | yes |
| Timeline charts: pick any built-in chart or numeric column, save the view | yes | yes |
| Error-mask decoding | yes | yes |
| Writes from the Playground | yes | yes, one row per sample |
| Remote config tab | yes | no — the REE devices are not configured remotely |

### Saved views

The *Received payloads* table and the *Reception timeline* each have a picker
(**Columns** / **Charts**) offering every column of the environment's table,
plus the built-in reception, size, counter, battery and coverage charts. The
selection applies at once; **Save view** keeps it in this browser's
`localStorage`, per environment, and **Reset to default** forgets it. The
defaults, in both environments:

- table: *Received*, *Device UID*, *Error mask*, *Counter*;
- charts: *Battery state of charge*.

**REE stores the batch context one column per field.** The 17 V1 context
fields (`error_mask`, `last_communication_error`, `battery_soc`,
`battery_voltage`, `config_crc32`, `boot_count`, `reset_source`, `rsrp`, `snr`,
`status_flags`, `tau`, `active_time`, `last_attach_duration_ms`,
`last_tx_duration_ms`, `reporting_lost_counter`, `tx_failed`,
`last_poll_status`) each have a `payloads_REE` column of the same name, holding
the raw value. The REE devices' V1 format is frozen, so the columns are fixed.
Rows stored before the columns were added have them all `NULL`: those values
were never kept, and the raw frame is not stored. With `status_flags` present,
the inspector also says whether `sample_time` is UTC or uptime.

> **The columns must exist before the code that writes them is deployed.** The
> REE insert names every context column, so against a table without them every
> device report is rejected and lost (the device still gets `204`).

---

## Protocol summary

All multi-byte fields are **little-endian**; `int8` / `int16` fields are **two's
complement** signed. Scaled fields carry a factor (engineering value = raw /
factor). The device UID is a raw byte array sent in order, never byte-swapped.

### V1

| Section  | Size            | Contents                                                                     |
| -------- | --------------- | ---------------------------------------------------------------------------- |
| Header   | 14 bytes        | version (uint8), device UID (uint8[8]), sample count (uint8), reporting counter (uint32) |
| Samples  | 36 × N bytes    | N consecutive 36-byte samples (read time + 15 channels each)                 |
| Context  | 43 bytes        | error mask plus battery, modem, reporting-loss and config diagnostics (17 fields) |

**Total length = 93 bytes** for the single sample devices send in practice.

The V1 document was revised twice **without changing the version byte** — 82
bytes, then 86, then the current 93. Stored payloads and devices on older
firmware use the earlier shapes, so all three still decode; the revision is told
apart by total length (unambiguous for any sample count) and shown in the
dashboard.

Each 36-byte sample decodes to: `time`, `thermocouple_1`, `thermocouple_2`,
`current_1_int_temp`, `current_2_int_temp`, `ambient_temperature`,
`ambient_humidity`, `internal_temperature`, `internal_humidity`, `luminosity`,
`acceleration_x`, `acceleration_y`, `acceleration_z`, `magnetic_field_1`,
`magnetic_field_2`, `valid_sample_mask`.

`time` is when the sample's read started. Bit 5 of `status_flags` says what it
is: set, **UTC seconds since 1970**; clear, **seconds since boot** (no clock sync
yet), in which case the reception time is the one to use. The dashboard shows
the UTC time on the Madrid clock, or the uptime with that note.

The `valid_sample_mask` says which sensors were read successfully. Fields of a
sensor whose bit is clear were transmitted as 0 and must be **discarded**, not
read as a measurement — the dashboard greys those channels out and labels them
"no reading".

### V0

| Section  | Size            | Contents                                            |
| -------- | --------------- | --------------------------------------------------- |
| Header   | 2 bytes         | payload id/version (uint8), sample count (uint8)     |
| Samples  | 28 × N bytes    | N consecutive 28-byte samples (13 channels each)     |
| Context  | 8 bytes         | error mask (uint32), reporting counter (uint32)      |

**Total length = `10 + 28 · N` bytes.**

Each 28-byte sample decodes to: `temp1_x10`, `temp2_x10`, `temp3_x10`,
`amb_temp_x10`, `amb_hum_x10`, `int_temp_x10`, `int_hum_x10`, `lux`, `accel_x`,
`accel_y`, `accel_z`, `current1`, `current2`.

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 18.18+ (or 20+)
- npm (or pnpm)
- A [Supabase](https://supabase.com/) project (optional for local decoding — the
  decoder and playground work without it; storage and the *Received Payloads*
  tab require it)

### Install

```bash
npm install
```

### Environment variables

Copy `.env.example` to `.env` (or `.env.local`) and fill in your credentials:

```bash
cp .env.example .env
```

| Variable                          | Required | Description                                              |
| --------------------------------- | -------- | -------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`        | yes\*    | Supabase project URL                                     |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`   | yes\*    | Supabase anonymous (public) key                          |
| `SUPABASE_SERVICE_ROLE_KEY`       | no       | Service-role key (server-only; optional admin operations)|

\* Required for storage and the *Received Payloads* list. The decoder,
Playground, and `POST /api/payloads` decoding still work without them (payloads
are simply returned with `stored: false`).

### Supabase setup

Run the migration scripts (in order) against your Supabase project — via the
Supabase SQL editor or the CLI:

```bash
# scripts/001_create_payloads.sql
# scripts/002_create_payload_error_codes.sql
# scripts/003_add_device_uid.sql
# scripts/004_add_v1_diagnostics_columns.sql
# scripts/005_add_v1_reporting_loss_columns.sql
# scripts/006_environment_and_ree_access.sql
```

They create the `payloads` table (with indexes on `created_at`,
`payload_version`, `error_mask`, `reporting_counter`) and the
`payload_error_codes` reference table, both with public read / insert RLS
policies matching the reference project. Script `003` adds the nullable
`device_uid` column carried by the V1 header.

> **Run `003` before deploying the code that writes it.** The payload insert
> names `device_uid` explicitly, so against an un-migrated table every insert is
> rejected. Storage failures are silent by design (the endpoint still answers
> `204`), so the symptom would be payloads that decode but never reach the
> dashboard.

Script `004` promotes the V1 battery and radio diagnostics out of the `context`
JSONB into indexable columns — `battery_soc`, `battery_voltage`, `rsrp`, `snr`
and `last_communication_error`. They are **`GENERATED … STORED` columns**:
Postgres derives each value from the `context` object the endpoint already
writes, so there is no application change, no backfill, and nothing ever writes
to them directly. Existing rows are populated the moment the column is added,
and V0 rows stay NULL because their context has no such keys.

Unlike `003`, this script is **not** deployment-order sensitive — the insert
never names these columns. Without it the app works normally; only the battery
and coverage charts are missing (the summary endpoint detects the absent columns
and falls back to the reception series alone).

Script `006` is required for the environment selection feature. It does **not**
create `environment` or `payloads_REE` — both already exist — it grants the
`anon` role the access the application needs and adds the same public read /
insert policies `001` already gives `payloads`. Without it both tables answer
every read with zero rows and reject every insert with `42501`, so the selector
shows **"No environments available."** and REE looks permanently empty.

> The REE table restricts writes to one device UID. That constraint is the
> database's and is **not** duplicated, weakened or worked around here: a
> rejected insert is shown to the user with the database's own message, and is
> never retried against `payloads`.

### Where each V1 field is stored

Both tables have **one column per V1 field**, with the same names, units and
scale. `payloads_REE` has them natively; `public.payloads` gets them as
**generated columns** read from the `samples` / `context` JSONB it already
stores:

| Field | `public.payloads` |
| ----- | ------- |
| `payload_version`, `sample_count`, `reporting_counter`, `error_mask`, `errors`, `byte_length` | Columns (pre-existing) |
| `device_uid` | Column (script `003`) |
| `battery_soc`, `battery_voltage`, `rsrp`, `snr`, `last_communication_error` | Generated (script `004`) |
| every other context field, `reporting_lost_counter` and `tx_failed` included | Generated (script `008`) |
| `sample_time` and the 15 channels of the first sample, as engineering values (°C, %RH) | Generated (script `008`) |

Script `008_payloads_v1_columns.sql` (in the Supabase scripts) also carries the
two columns of `005`, which had never been run against the database. It is
**not deployment-order sensitive**: nothing writes these columns, existing rows
are filled when they are added, V0 rows get `NULL`, and until it runs the new
columns just show empty.

### Reading the V1 counters and the battery

Three readings need care, and the dashboard already applies these rules:

- `reporting_lost_counter` and `tx_failed` are **counters since boot**. Read
  them as a delta between consecutive reports of the same boot session; a
  decreasing value means the device rebooted. The charts sum only the increases,
  so a reboot does not count backwards. `boot_count` itself is a **lifetime**
  count (uint32), never cleared, not even by a factory reset.
- `battery_soc` is **not clamped** — a gauge reading above 100 is sent as-is. A
  `0` **with** bit `0x00040000` (`ERR_RSN_BAT_STATUS_UNKNOWN`) set in the same
  report means the **fuel gauge failed**, not an empty battery, and is excluded
  from the battery chart. A `0` without that bit is a genuinely flat battery and
  is charted.
- `snr` uses `0` for "not available", but 0 dB is also a legal reading and v1
  carries no flag to separate them. Zeros are excluded from the coverage stats,
  which loses a real 0 dB reading in the process. v2 adds an explicit validity
  flag for the radio metrics.

### Run locally

```bash
npm run dev      # http://localhost:3000
```

---

## POST endpoint usage

`POST /api/payloads` — send the **raw binary** payload as the request body.

- Preferred `Content-Type: application/octet-stream`.
- The body is read with `request.arrayBuffer()` and is **never** parsed as JSON.
- **The response has no body** — the HTTP status is the entire answer: `204`
  accepted, `400` decode failure **or a format other than the current V1**
  (V0, older V1 revisions, no UID), `415` unreadable body, `500` unexpected
  error.
  Read the decoded payloads back with `GET /api/payloads` or in the dashboard.
  See [docs/api-payloads-ingest.md](docs/api-payloads-ingest.md) for the full
  endpoint contract.

### Which table an incoming payload lands in

A device sends no `environment` parameter, so the endpoint decides from the
payload itself: the decoded device UID is compared against the REE schema's
`writeDeviceUids` in [`lib/payload-schemas.ts`](lib/payload-schemas.ts) — the
same list the database restricts `payloads_REE` inserts to.

- **UID listed** → the report is stored in `public."payloads_REE"`, one row per
  sample.
- **Any other device** → `public.payloads`.

> The list lives in code, not in the table. Reading the reference UID back from
> `payloads_REE` made routing depend on the table it is meant to fill: while it
> was empty, nothing matched and every REE report went to `public.payloads`. A
> new REE device therefore means adding its UID to `writeDeviceUids` **and** to
> the database restriction.

The dashboard is different: it names `?environment=<name>` explicitly, that
choice is honoured as given with no UID-based rerouting, and the answer is JSON
(`201` stored / `422` rejected by the database) so a constraint violation is
shown rather than swallowed behind a `204`. Naming an environment the
application has no data source for is a `404` — never another environment's
table.

### Example (curl) — V1

```bash
# The canonical example payload from the V1 document (93 bytes, 1 sample).
echo -n "0100124B001A2B3C4D012A000000A068AA6AEB00F100DC00DF00BC008C02D7009001E2040000C60016FD1002DC05C8057F01180000000057AC0FEFCDAB890C00000002000000A1FF08B7C0A80000020008200000941100000200050000" \
  | xxd -r -p \
  | curl -s -o /dev/null -w '%{http_code}\n' \
      -X POST http://localhost:3000/api/payloads \
      -H "Content-Type: application/octet-stream" \
      --data-binary @-
# → 204
```

### Reading the decode back

`POST` answers with a status only, so the decoded form is read through the
listing endpoint (or the dashboard). `GET /api/payloads?limit=50&offset=0[&error_mask=24][&from=…&to=…]`
lists stored payloads, most recent first — each row carrying the raw hex, the
decoded `samples` / `context`, the resolved `errors`, and `device_uid`
(`null` for V0). To decode without storing anything, use `decodePayload()` /
`analyzePayload()` directly, or the **Playground** tab.

The V1 example payload above decodes to:

```jsonc
{
  "payload_version": 1,
  "layout_revision": "v1",
  "device_uid": "00:12:4B:00:1A:2B:3C:4D",
  "sample_count": 1,
  "reporting_counter": 42,
  "sample_time_utc": true, // status_flags bit 5
  "samples": [
    {
      "time": 1789552800, // 2026-09-16 10:00:00 UTC
      "thermocouple_1": 235, "thermocouple_2": 241,
      "current_1_int_temp": 220, "current_2_int_temp": 223,
      "ambient_temperature": 188, "ambient_humidity": 652,
      "internal_temperature": 215, "internal_humidity": 400,
      "luminosity": 1250,
      "acceleration_x": 198, "acceleration_y": -746, "acceleration_z": 528,
      "magnetic_field_1": 1500, "magnetic_field_2": 1480,
      "valid_sample_mask": 383 // 0x017F — every sensor OK except cable temp 3
    }
  ],
  "context": {
    "error_mask": 24, "last_communication_error": 0,
    "battery_soc": 87, "battery_voltage": 4012,
    "config_crc32": 2309737967, "boot_count": 12, "reset_source": 2,
    "rsrp": -95, "snr": 8,
    "status_flags": 183, // 0xB7: PSM granted + acceptable, attached, NB-IoT, time UTC, NTP
    "tau": 43200, "active_time": 2,
    "last_attach_duration_ms": 8200, "last_tx_duration_ms": 4500,
    "reporting_lost_counter": 2, "tx_failed": 5, "last_poll_status": 0,
    "reporting_counter": 42 // mirrored from the header
  },
  "error_mask_hex": "0x00000018",
  "errors": [
    { "code": "0x00000008", "name": "ERR_RSN_SENSOR_HALL_EFFECT_1", "description": "Cannot configure/read hall effect sensor 1" },
    { "code": "0x00000010", "name": "ERR_RSN_SENSOR_HALL_EFFECT_2", "description": "Cannot configure/read hall effect sensor 2" }
  ]
}
```

> Values are the **raw** integers. Apply `value / factor` for the engineering
> value (`thermocouple_1: 235` → `23.5 °C`).

---

## Remote config

The **Remote config** tab edits, per device, the configuration file the device
downloads from `GET /api/config`. It exists in the **Development** environment
only (`capabilities.remoteConfig` in the schema): REE hides the tab, and the
dashboard endpoints answer `403` for REE or for a device whose reports are
routed to `payloads_REE`. The user edits JSON; the device only ever
sees the plain-text v0 file. Everything about the format lives in
[`lib/remote-config.ts`](lib/remote-config.ts), shared by the editor's live
validation and the server, which validates every save again.

### The v0 file

Ten ASCII lines separated by LF (never CRLF), with a LF after the last one:
version `0`, `reporting_url`, `reporting_path`, `polling_url`, `polling_path`,
`apn`, an always-empty `api_key` ("keep the key"), `reporting_interval_ms`,
`polling_interval_ms`, and the CRC-32/ISO-HDLC (zlib) of lines 1–9 — including
the LF closing line 9 — as 8 uppercase hex digits. The test vector in
[`lib/remote-config.test.ts`](lib/remote-config.test.ts) is the template, 105
bytes, CRC `2442F46C`.

The JSON must have exactly the seven keys, none null; hosts are bare names
(`[A-Za-z0-9.-]`, 1–255, always HTTPS on 443); paths 1–127 printable characters
starting with `/`, no spaces, `#` or `://`; `apn` is `auto` or 1–63
`[A-Za-z0-9.-]`. Reporting runs 1 min – 6 h and polling 3 h – 24 h; the per-device
**Lab limits (Debug firmware)** option relaxes both to 1 s – 24 h, for bench tests
only.

### `GET /api/config` (called by the device)

| Status | When |
| ------ | ---- |
| `200` | a config is saved: the exact file, `text/plain; charset=us-ascii` |
| `204` | the token is known but no config is saved: the device keeps its own |
| `401` | no `Authorization` header, or an unknown token |
| `500` | anything else |

Every answer is `Cache-Control: no-store`. The firmware does not follow
redirects, so it must call `/api/config` exactly: `/api/config/` is a 308.

The request has no body, so the device is identified by its Bearer token. The
application learns token → device UID from the reports it POSTs to
`/api/payloads`, which carry both. It stores only the token's SHA-256, keeps
the first pairing seen for a token, and never logs the header. A device
therefore gets `401` until its first report after this is deployed.

### Tables

`device_config` (one row per device, the saved config plus its generated file
and CRC) and `device_api_key` (token hash → device UID), reached with the anon
key like `payloads`: public read and insert, plus update on `device_config`.
This is a debug platform, so that is deliberate, but it means anyone holding
the (public) anon key can edit a device's config — and with it the server the
device polls — without going through the dashboard. The SQL is
`007_remote_config.sql` in the Supabase scripts.

### States in the tab

The devices listed are the ones that have reported to Development.
For each one the tab compares the `config_crc32` of its newest payload with the
saved file's CRC: **Applied** when they match, **Pending** when a config is
saved and they don't, **No remote config** when nothing is saved. The device
tries a new file, confirms it after one good report and poll, and reverts it
after three failures (`last_poll_status` 8), so Applied can turn back into
Pending.

---

## The decoder module

`lib/payload-decoder.ts` is a framework-free, reusable module.

- `decodePayload(input)` — accepts `Buffer | ArrayBuffer | Uint8Array`, returns
  the structured `DecodedPayload` (version, device UID, sample count, samples,
  context, error mask, reporting counter, resolved errors). The version byte at
  offset 0 selects the layout; V0 and V1 are both handled.
- `layoutFor(version)`, `sampleFieldsFor(version)`, `contextFieldsFor(version)` —
  the per-version field tables the UI iterates to render a payload. Adding a
  future V2 means adding one entry to `LAYOUTS`, not branching at each call site.
- `analyzePayload(input)` — `decodePayload` plus hex/binary representations and
  per-byte section annotation used by the UI.
- Validation throws `PayloadDecodeError` with a stable `code`: `EMPTY_PAYLOAD`,
  `INVALID_LENGTH`, `UNSUPPORTED_VERSION`, `SAMPLE_COUNT_MISMATCH`,
  `MALFORMED_BODY`.
- Helpers: `hexToBytes`, `bytesToHex`, `bytesToBinary`.

Error codes are resolved via `lib/payload-errors.ts` (mirrors the *Error Codes*
document and `scripts/002_create_payload_error_codes.sql`). That module also
resolves the V1 lookups: the valid sample mask, the last-communication-error
enum, the modem status flags, and the reset source.

`lib/payload-spec.test.ts` transcribes the V1 document tables literally and
asserts the implementation against them — field order, types, factors, units,
and that each section tiles its bytes exactly with no gap or overlap. When the
protocol document changes, update that file first: the failures then point at
every place the code has to follow.

---

## Testing

```bash
npm test          # vitest run
```

`lib/payload-decoder.test.ts` covers the canonical example payload of **both**
formats (header, device UID, signed sample values, full context, error-mask
resolution, byte-section annotation) and every validation branch, including the
V1 rule that a payload must carry exactly one sample.

---

## Deployment (Vercel)

1. Import the repository into Vercel — it auto-detects Next.js.
2. Add the environment variables in **Project → Settings → Environment
   Variables**:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (optional)
3. Deploy.

The `POST /api/payloads` route is an App Router Route Handler pinned to the
Node.js runtime (`export const runtime = "nodejs"`) and reads the raw body with
`request.arrayBuffer()`, so binary bodies work on Vercel serverless functions
without any body-parser configuration.
