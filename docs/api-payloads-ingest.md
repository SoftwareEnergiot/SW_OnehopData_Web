# `POST /api/payloads` — Payload Ingestion Endpoint

Receives a **raw binary LoRaWAN V0 payload** from a device, decodes it according
to the *Payload Encode - LoraWAN V0* protocol, and best-effort stores both the raw
and decoded forms in Supabase.

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

### curl — canonical example payload (150 bytes, 5 samples)

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

`created_at` is returned as stored (UTC). The dashboard renders those clock
fields verbatim — it applies **no** timezone conversion — so the times on screen
always match the `created_at` column, and the `from` / `to` filter is read on the
same clock.
```
