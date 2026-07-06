# `POST /api/payloads` — Payload Ingestion Endpoint

Receives a **raw binary LoRaWAN V0 payload** from a device, decodes it according
to the *Payload Encode - LoraWAN V0* protocol, best-effort stores both the raw
and decoded forms in Supabase, and returns the full analysis as JSON.

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

The **raw binary payload** — not JSON, not base64, not a hex string. The byte
layout (all multi-byte fields little-endian; `int16` two's-complement signed):

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

### `200 OK` — success

`Content-Type: application/json`. Body shape (`PayloadIngestResponse` in
`lib/types.ts`):

| Field            | Type                | Description                                                             |
| ---------------- | ------------------- | ---------------------------------------------------------------------- |
| `success`        | `boolean`           | Always `true` on a `200`.                                              |
| `stored`         | `boolean`           | `true` if persisted to Supabase; `false` if storage was skipped/failed. |
| `id`             | `string \| null`    | Row id of the stored payload, or `null` when not stored.               |
| `meta`           | `object`            | `{ byteLength, expectedLength, sampleCount, version }`.                 |
| `hex`            | `string`            | Continuous lowercase hexadecimal of the raw body.                      |
| `binary`         | `string`            | Space-separated 8-bit binary of each byte.                             |
| `header`         | `object`            | `{ payload_version, sample_count }`.                                    |
| `samples`        | `DecodedSample[]`   | One object per sample, with the 13 channels above (raw values).        |
| `context`        | `object`            | `{ error_mask, reporting_counter }`.                                    |
| `error_mask`     | `number`            | Numeric error mask (unsigned 32-bit).                                  |
| `error_mask_hex` | `string`            | Canonical form, e.g. `"0x00000018"`.                                   |
| `reporting_counter` | `number`         | Device reporting counter.                                             |
| `errors`         | `ResolvedError[]`   | Expanded error flags: `{ bit, code, name, description, color }`.        |

> **Storage is best-effort.** If Supabase is not configured or the insert fails,
> the decode still succeeds and the response is returned with `stored: false`
> and `id: null`. A storage failure never turns into an HTTP error.

### Error responses

Decode failures map a stable error `code` to an HTTP status. Body shape
(`PayloadErrorResponse` in `lib/types.ts`): `{ success: false, error, code }`.

| HTTP status | `code`                  | Cause                                                                     |
| ----------- | ----------------------- | ------------------------------------------------------------------------- |
| `400`       | `EMPTY_PAYLOAD`         | Request body was empty (0 bytes).                                         |
| `400`       | `INVALID_LENGTH`        | Too short, or the sample region is not a multiple of 28 bytes.           |
| `400`       | `UNSUPPORTED_VERSION`   | Header version byte is not a supported version (only `0` / V0).          |
| `400`       | `SAMPLE_COUNT_MISMATCH` | Header sample count disagrees with the length-implied count.             |
| `415`       | `MALFORMED_BODY`        | Body could not be read as raw bytes.                                     |
| `500`       | *(none)*                | Unexpected server error: `{ success: false, error, details }`.           |

---

## Examples

### curl — canonical example payload (150 bytes, 5 samples)

The body must be sent as raw bytes. Convert a hex string to binary with `xxd -r -p`
and stream it with `--data-binary @-`:

```bash
echo -n "0005BB00DA00D700BC008C020000000000000000C60016FD100200000000BB00BA00D700BC008C020000000000000000C60016FD110200000000BB00DA00D700BC008C020000000000000000C70016FD100200000000BA00DA00D700BC008C020000000000000000C60016FD110200000000BA00DA00D700BC008B020000000000000000C60016FD1102000000001800000000000000" \
  | xxd -r -p \
  | curl -s -X POST https://onehop-data.vercel.app/api/payloads \
      -H "Content-Type: application/octet-stream" \
      --data-binary @- | jq
```

### Node.js (fetch)

```js
// `payload` is a Buffer / Uint8Array of raw bytes.
const res = await fetch("https://onehop-data.vercel.app/api/payloads", {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream" },
  body: payload,
});
const analysis = await res.json();
```

### Expected decoded output (excerpt)

```jsonc
{
  "success": true,
  "stored": false,
  "id": null,
  "meta": { "byteLength": 150, "expectedLength": 150, "sampleCount": 5, "version": 0 },
  "header": { "payload_version": 0, "sample_count": 5 },
  "samples": [
    {
      "temp1_x10": 187, "temp2_x10": 218, "temp3_x10": 215,
      "amb_temp_x10": 188, "amb_hum_x10": 652,
      "int_temp_x10": 0, "int_hum_x10": 0, "lux": 0,
      "accel_x": 198, "accel_y": -746, "accel_z": 528,
      "current1": 0, "current2": 0
    }
    // … 4 more samples
  ],
  "context": { "error_mask": 24, "reporting_counter": 0 },
  "error_mask": 24,
  "error_mask_hex": "0x00000018",
  "reporting_counter": 0,
  "errors": [
    { "code": "0x00000008", "name": "ERR_RSN_SENSOR_HALL_EFFECT_1", "description": "Cannot configure/read hall effect sensor 1" },
    { "code": "0x00000010", "name": "ERR_RSN_SENSOR_HALL_EFFECT_2", "description": "Cannot configure/read hall effect sensor 2" }
  ]
}
```

---

## Related: `GET /api/payloads` (listing)

Lists stored payloads, most recent first. Also public (no auth). Query
parameters:

| Param        | Type     | Default | Description                                                            |
| ------------ | -------- | ------- | ---------------------------------------------------------------------- |
| `limit`      | `number` | `50`    | Page size.                                                             |
| `offset`     | `number` | `0`     | Rows to skip.                                                          |
| `error_mask` | `number` | —       | Optional exact-match filter on `error_mask`.                          |
| `from`       | `string` | —       | Optional lower bound on the received timestamp (`created_at`, inclusive). Any `Date`-parseable value, e.g. an ISO 8601 instant. |
| `to`         | `string` | —       | Optional upper bound on the received timestamp (`created_at`, inclusive). Any `Date`-parseable value, e.g. an ISO 8601 instant. |

Unparseable `from` / `to` values are ignored rather than erroring. Example:
`GET /api/payloads?from=2026-07-01T00:00:00Z&to=2026-07-06T23:59:59Z`.

Response: `{ success, data: PayloadRecord[], total, limit, offset }`.
```
