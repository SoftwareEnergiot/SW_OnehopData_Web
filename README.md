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
| **V1** (current) | [Confluence — V1](https://energiot.atlassian.net/wiki/spaces/WSNFD/pages/670793729/V1) | 82 bytes | yes |
| **V0** (legacy)  | *Payload Encode - LoraWAN V0* | `10 + 28 · N` bytes | no |

V0 stays supported so already-deployed devices keep working.

It is built with the same stack and conventions as the reference Sensor Data
Platform: **Next.js (App Router) + TypeScript (strict) + Tailwind CSS v4 +
shadcn/ui + Supabase**, tested with **Vitest**.

---

## Protocol summary

All multi-byte fields are **little-endian**; `int8` / `int16` fields are **two's
complement** signed. Scaled fields carry a factor (engineering value = raw /
factor). The device UID is a raw byte array sent in order, never byte-swapped.

### V1

| Section  | Size            | Contents                                                                     |
| -------- | --------------- | ---------------------------------------------------------------------------- |
| Header   | 14 bytes        | version (uint8), device UID (uint8[8]), sample count (uint8), reporting counter (uint32) |
| Samples  | 32 × N bytes    | N consecutive 32-byte samples (15 channels each)                              |
| Context  | 36 bytes        | error mask plus battery and modem diagnostics (14 fields)                     |

**Total length = 82 bytes.** `sample_count` is always **1**; a payload declaring
any other count is rejected, even when its length agrees with the header.

Each 32-byte sample decodes to: `thermocouple_1`, `thermocouple_2`,
`current_1_int_temp`, `current_2_int_temp`, `ambient_temperature`,
`ambient_humidity`, `internal_temperature`, `internal_humidity`, `luminosity`,
`acceleration_x`, `acceleration_y`, `acceleration_z`, `magnetic_field_1`,
`magnetic_field_2`, `valid_sample_mask`.

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

### Where each V1 field is stored

| Field | Storage |
| ----- | ------- |
| `payload_version`, `sample_count`, `reporting_counter`, `error_mask`, `errors`, `byte_length` | Columns (pre-existing) |
| `device_uid` | Column (script `003`) |
| `battery_soc`, `battery_voltage`, `rsrp`, `snr`, `last_communication_error` | Generated columns (script `004`) **and** `context` |
| The 15 sample channels, `valid_sample_mask` included | `samples` JSONB |
| `config_version`, `boot_count`, `reset_source`, `tau`, `active_time`, `last_attach_duration_ms`, `last_tx_duration_ms` | `context` JSONB only |

Nothing is dropped: every decoded field reaches the database. The JSONB-only
fields are simply not indexed or typed — query them with `context->>'field'`, or
promote one to a generated column by copying a line from script `004`.

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
  accepted, `400` decode failure, `415` unreadable body, `500` unexpected error.
  Read the decoded payloads back with `GET /api/payloads` or in the dashboard.
  See [docs/api-payloads-ingest.md](docs/api-payloads-ingest.md) for the full
  endpoint contract.

### Example (curl) — V1

```bash
# The canonical example payload from the V1 document (82 bytes, 1 sample).
echo -n "0100124B001A2B3C4D012A000000EB00F100DC00DF00BC008C02D7009001E2040000C60016FD1002DC05C8057F01180000000057AC0F030000000C0002000000A1FF0817C0A8000002000820000094110000" \
  | xxd -r -p \
  | curl -s -o /dev/null -w '%{http_code}\n' \
      -X POST http://localhost:3000/api/payloads \
      -H "Content-Type: application/octet-stream" \
      --data-binary @-
# → 204
```

### Example (curl) — V0

```bash
# The canonical example payload from the V0 protocol document (150 bytes, 5 samples).
echo -n "0005BB00DA00D700BC008C020000000000000000C60016FD100200000000BB00BA00D700BC008C020000000000000000C60016FD110200000000BB00DA00D700BC008C020000000000000000C70016FD100200000000BA00DA00D700BC008C020000000000000000C60016FD110200000000BA00DA00D700BC008B020000000000000000C60016FD1102000000001800000000000000" \
  | xxd -r -p \
  | curl -s -X POST http://localhost:3000/api/payloads \
      -H "Content-Type: application/octet-stream" \
      --data-binary @- | jq
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
  "device_uid": "00:12:4B:00:1A:2B:3C:4D",
  "sample_count": 1,
  "reporting_counter": 42,
  "samples": [
    {
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
    "config_version": 3, "boot_count": 12, "reset_source": 2,
    "rsrp": -95, "snr": 8, "status_flags": 23,
    "tau": 43200, "active_time": 2,
    "last_attach_duration_ms": 8200, "last_tx_duration_ms": 4500,
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
