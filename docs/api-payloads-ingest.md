# `POST /api/payloads` — Payload Ingestion Endpoint

Receives a **raw binary Onehop payload** from a device, decodes it, and
best-effort stores both the raw and decoded forms in Supabase.

Two payload formats are accepted, selected by the **version byte at offset 0**:

| Version byte | Format | Source document | Total length |
| ------------ | ------ | --------------- | ------------ |
| `0x00`       | V0     | *Payload Encode - LoraWAN V0*                | `10 + 28 · N` bytes |
| `0x01`       | V1     | [Confluence — V1](https://energiot.atlassian.net/wiki/spaces/WSNFD/pages/670793729/V1) | `86` bytes (N = 1) |

V1 is the current device format; V0 remains accepted so already-deployed
devices keep working. Any other version byte is rejected with `400`.

> **The response has no body.** The endpoint answers with an **HTTP status only** —
> `204 No Content` when the payload was accepted, a `4xx` when it could not be
> decoded, `500` on an unexpected error. Nothing about the decode (or about the
> storage outcome) is returned to the caller. Read the decoded payloads back with
> `GET /api/payloads` or in the dashboard.

> **Authentication: none.** This endpoint is intentionally **public** — external
> LoRaWAN devices POST here machine-to-machine and have no Clerk session. It is
> exempted from auth in `middleware.ts` (`'/api/payloads(.*)'` in the public
> route matcher) and the handler performs **no** API-key, token, or `Authorization`
> checks. Do not send auth headers or auth query parameters; they are ignored.

- **Source:** `app/api/payloads/route.ts` (`POST` handler)
- **Runtime:** Node.js (`export const runtime = "nodejs"`) — required so the full
  request buffer is available via `request.arrayBuffer()`.
- **Dynamic:** `export const dynamic = "force-dynamic"` (never cached).

---

## Request

### Method & URL

The endpoint is a Next.js App Router Route Handler mounted at the path segment
`app/api/payloads/route.ts` → `/api/payloads`.

| Environment | Full URL                                        |
| ----------- | ----------------------------------------------- |
| Production  | `https://onehop-data.vercel.app/api/payloads`   |
| Local dev   | `http://localhost:3000/api/payloads`            |

```
POST https://onehop-data.vercel.app/api/payloads
```

Devices should target the **production** URL above. The path is fixed — there is
no version prefix or trailing segment; the payload goes in the request body, not
the path.

### Headers

| Header         | Required | Value / Notes                                                                  |
| -------------- | -------- | ------------------------------------------------------------------------------ |
| `Content-Type` | No\*     | Preferred `application/octet-stream`. The body is read as raw bytes regardless. |

\* The body is **never** parsed as JSON — it is read verbatim with
`request.arrayBuffer()`. `Content-Type` is not validated, but sending
`application/octet-stream` is the correct, explicit choice for a binary body.

The following request headers, if present, are recorded with the stored payload
(purely informational — they are **not** authentication):

| Header                         | Stored as          | Notes                                    |
| ------------------------------ | ------------------ | ---------------------------------------- |
| `x-forwarded-for` / `x-real-ip` | `source_ip`        | First available is used as the source IP. |
| `user-agent`                   | `source_user_agent` | Recorded verbatim.                       |

### Body

The **raw binary payload** — not JSON, not base64, not a hex string. In both
formats every multi-byte field is little-endian and `int8` / `int16` fields are
two's-complement signed. The `device_uid` is a raw byte array sent in order, so
it is never byte-swapped.

#### V1 layout (version byte `0x01`)

| Section  | Size          | Contents                                                                          |
| -------- | ------------- | --------------------------------------------------------------------------------- |
| Header   | 14 bytes      | version (`uint8`), device UID (`uint8[8]`), sample count (`uint8`), reporting counter (`uint32`) |
| Samples  | 32 × N bytes  | N consecutive 32-byte samples (15 channels each)                                   |
| Context  | 40 bytes      | error mask plus battery, modem and reporting-loss diagnostics (16 fields)           |

**Total length = 86 bytes.** `sample_count` is **always 1** in V1 — a payload
declaring any other count is rejected with `400`, even when its length agrees
with the header. The field is kept in the format for v2, which will add the
timestamping needed to place several samples in time.

Each 32-byte V1 sample decodes to:

| Field                  | Offset | Type     | Factor | Unit | Label                           |
| ---------------------- | ------ | -------- | ------ | ---- | ------------------------------- |
| `thermocouple_1`       | 0      | `int16`  | 10     | °C   | Cable temperature, probe 1      |
| `thermocouple_2`       | 2      | `int16`  | 10     | °C   | Cable temperature, probe 2      |
| `current_1_int_temp`   | 4      | `int16`  | 10     | °C   | Die temp of magnetic sensor 1   |
| `current_2_int_temp`   | 6      | `int16`  | 10     | °C   | Die temp of magnetic sensor 2   |
| `ambient_temperature`  | 8      | `int16`  | 10     | °C   | Outside the enclosure           |
| `ambient_humidity`     | 10     | `uint16` | 10     | %RH  | Outside the enclosure           |
| `internal_temperature` | 12     | `int16`  | 10     | °C   | Inside the enclosure            |
| `internal_humidity`    | 14     | `uint16` | 10     | %RH  | Inside the enclosure            |
| `luminosity`           | 16     | `uint32` | 1      | lux  | Ambient light                   |
| `acceleration_x`       | 20     | `int16`  | 1      | mg   | Tilt / vibration                |
| `acceleration_y`       | 22     | `int16`  | 1      | mg   | Tilt / vibration                |
| `acceleration_z`       | 24     | `int16`  | 1      | mg   | Tilt / vibration                |
| `magnetic_field_1`     | 26     | `uint16` | 1      | µT   | RMS field, sensor 1             |
| `magnetic_field_2`     | 28     | `uint16` | 1      | µT   | RMS field, sensor 2             |
| `valid_sample_mask`    | 30     | `uint16` | 1      | —    | Which sensors were read OK      |

**Valid sample mask** — bit set = sensor read OK and its fields are valid; bit
clear = its fields were transmitted as 0 and must be discarded, not read as a
measurement. Bit 0 ambient (external), 1 luminosity, 2 accelerometer,
3 current 1, 4 current 2, 5 cable temp 1, 6 cable temp 2, 7 cable temp 3
(unused in V1, always 0), 8 ambient (internal); bits 9-15 reserved.

The 40-byte V1 context: `error_mask` (`uint32`, offset 0),
`last_communication_error` (`uint8`, 4), `battery_soc` (`uint8`, 5),
`battery_voltage` (`uint16`, 6), `config_version` (`uint32`, 8),
`boot_count` (`uint16`, 12), `reset_source` (`uint32`, 14), `rsrp` (`int16`, 18),
`snr` (`int8`, 20), `status_flags` (`uint8`, 21), `tau` (`uint32`, 22),
`active_time` (`uint16`, 26), `last_attach_duration_ms` (`uint32`, 28),
`last_tx_duration_ms` (`uint32`, 32), `reporting_lost_counter` (`uint16`, 36),
`tx_failed` (`uint16`, 38).

Fields 8 to 14 (`rsrp` through `last_tx_duration_ms`) are refreshed by the modem
only while it registers on the network, so they describe the **previous**
transmission cycle, not the instant the report was built.

Fields 6, 15 and 16 (`boot_count`, `reporting_lost_counter`, `tx_failed`) are
counters since boot. Read them as a **delta between consecutive reports of the
same boot session**; their wrap is harmless, and a decreasing value means the
device rebooted, which the boot count confirms. `reporting_lost_counter`
explains every gap in the reporting counter: a report is lost either because its
transmission failed, or because it was overwritten in the outbox before the
previous one could be sent. In this firmware release there are no transmission
retries, so `tx_failed` tracks it exactly; the two diverge only once retries
exist.

Two readings need care, and the dashboard handles both:

- **`battery_soc`** is not clamped by the firmware, so a gauge reading above 100
  is transmitted as-is. A value of `0` **together with** bit `0x00040000`
  (`ERR_RSN_BAT_STATUS_UNKNOWN`) in the same report's error mask means the fuel
  gauge failed, **not** an empty battery — that reading is excluded from the
  battery chart rather than plotted as a drop to zero. A `0` without that bit is
  a genuinely flat battery and is charted.
- **`snr`** uses `0` for "not available", but 0 dB is also a legal reading and v1
  carries no flag to tell the two apart. Zeros are therefore excluded from the
  coverage statistics, which loses a real 0 dB reading in the process. v2 adds an
  explicit validity flag for the radio metrics, which is what resolves this.

**`reset_source`** is stored as the raw `uint32` the device sends. The dashboard
additionally labels it with the reset reason — `PWR_ON`, `PIN_RESET`,
`VDDS_LOSS`, `VDDR_LOSS`, `CLK_LOSS`, `SYSRESET`, `WARMRESET`,
`WAKEUP_FROM_SHUTDOWN` — the CC13x2/CC26x2 reset sources of the TI CC1352R the
device is built on, as returned by driverlib `SysCtrlResetSourceGet()`.

> The protocol document does not define these values; it only says "MCU reset
> source register of the last boot". The mapping is inferred from the part and
> is **pending confirmation against the firmware**. The raw hex is always shown
> next to the label, and a value outside 0-7 is reported as unrecognised rather
> than decoded — that would suggest the firmware sends the whole `RESETCTL`
> register instead of the extracted field. The table lives in
> `RESET_SOURCES` in `lib/payload-errors.ts`.

> The reporting counter lives in the V1 **header**, not the context. It is
> mirrored into the stored `context` object (and the `reporting_counter` column)
> so both formats expose it in the same place.

#### V0 layout (version byte `0x00`)

| Section  | Size          | Contents                                          |
| -------- | ------------- | ------------------------------------------------- |
| Header   | 2 bytes       | payload version (`uint8`), sample count (`uint8`)  |
| Samples  | 28 × N bytes  | N consecutive 28-byte samples (13 channels each)   |
| Context  | 8 bytes       | error mask (`uint32`), reporting counter (`uint32`) |

**Total length = `10 + 28 · N` bytes.**

Each 28-byte sample decodes to these channels (offset within the sample, type,
scaling factor, unit):

| Field          | Offset | Type     | Factor | Unit  | Label                        |
| -------------- | ------ | -------- | ------ | ----- | ---------------------------- |
| `temp1_x10`    | 0      | `int16`  | 10     | °C    | Termopar 1                   |
| `temp2_x10`    | 2      | `int16`  | 10     | °C    | Termopar 2                   |
| `temp3_x10`    | 4      | `int16`  | 10     | °C    | Termopar 3 / CurrSens1       |
| `amb_temp_x10` | 6      | `int16`  | 10     | °C    | Ambient temperature          |
| `amb_hum_x10`  | 8      | `uint16` | 10     | %     | Ambient humidity             |
| `int_temp_x10` | 10     | `int16`  | 10     | °C    | Internal temp / CurrSens2    |
| `int_hum_x10`  | 12     | `uint16` | 10     | %     | Internal humidity            |
| `lux`          | 14     | `uint32` | 1      | lux   | Luminosity                   |
| `accel_x`      | 18     | `int16`  | 1      | mg    | Acceleration x               |
| `accel_y`      | 20     | `int16`  | 1      | mg    | Acceleration y               |
| `accel_z`      | 22     | `int16`  | 1      | mg    | Acceleration z               |
| `current1`     | 24     | `uint16` | 1      | µT    | Current 1                    |
| `current2`     | 26     | `uint16` | 1      | µT    | Current 2                    |

> The API returns the **raw** (unscaled) integer values. Apply `value / factor`
> to obtain the engineering value (e.g. `temp1_x10: 187` → `18.7 °C`).

### No query parameters

`POST /api/payloads` takes **no** query parameters. (The listing endpoint,
`GET /api/payloads`, accepts `limit`, `offset`, and `error_mask` — see the end of
this document.)

---

## Response

**Always empty.** No JSON, no headers carrying the decode — the status code is
the entire answer. Clients should branch on `response.status` alone; the decode
detail is written to the server log, not to the caller.

| HTTP status | Meaning                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `204`       | Payload decoded and accepted.                                                    |
| `400`       | Decode failed: empty body, invalid length, unsupported version, or a header sample-count mismatch. |
| `415`       | Body could not be read as raw bytes.                                            |
| `500`       | Unexpected server error.                                                         |

> **Storage is best-effort and invisible to the caller.** If Supabase is not
> configured or the insert fails, the payload still decoded, so the request is
> still answered with `204`. A storage failure never turns into an HTTP error,
> and the caller is not told whether the row was written — check the dashboard or
> `GET /api/payloads`.

The internal decode error codes (`EMPTY_PAYLOAD`, `INVALID_LENGTH`,
`UNSUPPORTED_VERSION`, `SAMPLE_COUNT_MISMATCH` → `400`; `MALFORMED_BODY` → `415`)
are logged server-side only.

---

## Examples

### curl — canonical V1 example payload (86 bytes, 1 sample)

```bash
echo -n "0100124B001A2B3C4D012A000000EB00F100DC00DF00BC008C02D7009001E2040000C60016FD1002DC05C8057F01180000000057AC0F030000000C0002000000A1FF0817C0A800000200082000009411000002000500" \
  | xxd -r -p \
  | curl -s -o /dev/null -w '%{http_code}\n' \
      -X POST https://onehop-data.vercel.app/api/payloads \
      -H "Content-Type: application/octet-stream" \
      --data-binary @-
# → 204
```

### curl — canonical V0 example payload (150 bytes, 5 samples)

The body must be sent as raw bytes. Convert a hex string to binary with `xxd -r -p`
and stream it with `--data-binary @-`. There is no body to print, so ask curl for
the status code:

```bash
echo -n "0005BB00DA00D700BC008C020000000000000000C60016FD100200000000BB00BA00D700BC008C020000000000000000C60016FD110200000000BB00DA00D700BC008C020000000000000000C70016FD100200000000BA00DA00D700BC008C020000000000000000C60016FD110200000000BA00DA00D700BC008B020000000000000000C60016FD1102000000001800000000000000" \
  | xxd -r -p \
  | curl -s -o /dev/null -w '%{http_code}\n' \
      -X POST https://onehop-data.vercel.app/api/payloads \
      -H "Content-Type: application/octet-stream" \
      --data-binary @-
# → 204
```

### Node.js (fetch)

```js
// `payload` is a Buffer / Uint8Array of raw bytes.
const res = await fetch("https://onehop-data.vercel.app/api/payloads", {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream" },
  body: payload,
});
// No body is returned — the status is the result.
if (!res.ok) throw new Error(`Payload rejected: HTTP ${res.status}`);
```

---

## Related: `GET /api/payloads` (listing)

Lists stored payloads, most recent first — this is how decoded payloads are read
back. Also public (no auth). Query parameters:

| Param        | Type     | Default | Description                                                            |
| ------------ | -------- | ------- | ---------------------------------------------------------------------- |
| `limit`      | `number` | `50`    | Page size.                                                             |
| `offset`     | `number` | `0`     | Rows to skip. With `limit`, pages through every payload in the range.  |
| `error_mask` | `number` | —       | Optional exact-match filter on `error_mask`.                          |
| `from`       | `string` | —       | Optional lower bound on the received timestamp (`created_at`, inclusive). Any `Date`-parseable value, e.g. an ISO 8601 instant. |
| `to`         | `string` | —       | Optional upper bound on the received timestamp (`created_at`, inclusive). Any `Date`-parseable value, e.g. an ISO 8601 instant. |

Unparseable `from` / `to` values are ignored rather than erroring. Example:
`GET /api/payloads?from=2026-07-01T00:00:00Z&to=2026-07-06T23:59:59Z&limit=50&offset=100`.

Response: `{ success, data: PayloadRecord[], total, limit, offset }` — `total` is
the full count matching the filter (ignoring `limit`/`offset`), which is what the
dashboard uses to page through the range.

Each row carries `device_uid`, the V1 header UID formatted as uppercase
colon-separated hex (`"00:12:4B:00:1A:2B:3C:4D"`). It is `null` for V0 payloads,
which have no UID, and for any row stored before `scripts/003_add_device_uid.sql`
was applied.

Rows also carry `battery_soc`, `battery_voltage`, `rsrp`, `snr` and
`last_communication_error` once `scripts/004_add_v1_diagnostics_columns.sql` has
been applied. These are `GENERATED … STORED` columns derived from the `context`
object, so they are always consistent with it and are `null` for V0 payloads.
Every other V1 context field (`config_version`, `boot_count`, `reset_source`,
`tau`, `active_time`, `last_attach_duration_ms`, `last_tx_duration_ms`) is
available inside `context` itself.

### `GET /api/payloads/summary` (chart series)

Returns `{ success, points, total, truncated }` with one point per payload in
the range, ordered oldest first: `created_at`, `byte_length`,
`reporting_counter`, plus `battery_soc`, `battery_voltage`, `rsrp` and `snr`
when script `004` has been applied. Takes the same `from` / `to` bounds.

`rsrp` and `snr` are `0` when the modem had no measurement — the dashboard
excludes those from the coverage statistics rather than charting them as an
unusually strong signal. A `battery_soc` of `0`, by contrast, is a real reading
(a flat battery) and is charted as such.

`created_at` is returned as stored (UTC). The dashboard converts it to Madrid
local time (`Europe/Madrid`, CET/CEST) for display — table stamps, chart axes and
tooltips all read on that clock, with no offset shown — and the `from` / `to`
filter inputs are read as Madrid local time and sent to the API as UTC instants,
so the range selects exactly the rows shown.
```
