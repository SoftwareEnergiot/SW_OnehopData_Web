# Onehop Payload Platform

Receive, decode, store, and inspect **LoRaWAN V0 binary payloads**.

Devices `POST` a raw binary payload to an HTTP endpoint. The server decodes it
according to the *Payload Encode - LoraWAN V0* protocol, stores both the raw and
decoded forms in Supabase, and the dashboard renders a binary-vs-hexadecimal
comparison plus a full field-by-field deconstruction (header, samples, batch
context, and error mask).

It is built with the same stack and conventions as the reference Sensor Data
Platform: **Next.js (App Router) + TypeScript (strict) + Tailwind CSS v4 +
shadcn/ui + Supabase**, tested with **Vitest**.

---

## Protocol summary

All multi-byte fields are **little-endian**; `int16` fields are **two's
complement** signed. Fields marked `x10` are scaled (engineering value = raw / factor).

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
```

They create the `payloads` table (with indexes on `created_at`,
`payload_version`, `error_mask`, `reporting_counter`) and the
`payload_error_codes` reference table, both with public read / insert RLS
policies matching the reference project.

### Run locally

```bash
npm run dev      # http://localhost:3000
```

---

## POST endpoint usage

`POST /api/payloads` — send the **raw binary** payload as the request body.

- Preferred `Content-Type: application/octet-stream`.
- The body is read with `request.arrayBuffer()` and is **never** parsed as JSON.
- Returns a JSON analysis: raw metadata, hexadecimal, binary, decoded header,
  samples, context, and resolved error flags.

### Example (curl)

```bash
# The canonical example payload from the protocol document (150 bytes, 5 samples).
echo -n "0005BB00DA00D700BC008C020000000000000000C60016FD100200000000BB00BA00D700BC008C020000000000000000C60016FD110200000000BB00DA00D700BC008C020000000000000000C70016FD100200000000BA00DA00D700BC008C020000000000000000C60016FD110200000000BA00DA00D700BC008B020000000000000000C60016FD1102000000001800000000000000" \
  | xxd -r -p \
  | curl -s -X POST http://localhost:3000/api/payloads \
      -H "Content-Type: application/octet-stream" \
      --data-binary @- | jq
```

### Expected decoded output (excerpt)

```jsonc
{
  "success": true,
  "stored": false,
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
  "error_mask_hex": "0x00000018",
  "errors": [
    { "code": "0x00000008", "name": "ERR_RSN_SENSOR_HALL_EFFECT_1", "description": "Cannot configure/read hall effect sensor 1" },
    { "code": "0x00000010", "name": "ERR_RSN_SENSOR_HALL_EFFECT_2", "description": "Cannot configure/read hall effect sensor 2" }
  ]
}
```

`GET /api/payloads?limit=50&offset=0[&error_mask=24]` lists stored payloads,
most recent first.

---

## The decoder module

`lib/payload-decoder.ts` is a framework-free, reusable module.

- `decodePayload(input)` — accepts `Buffer | ArrayBuffer | Uint8Array`, returns
  the structured `DecodedPayload` (version, sample count, samples, context,
  error mask, reporting counter, resolved errors).
- `analyzePayload(input)` — `decodePayload` plus hex/binary representations and
  per-byte section annotation used by the UI.
- Validation throws `PayloadDecodeError` with a stable `code`: `EMPTY_PAYLOAD`,
  `INVALID_LENGTH`, `UNSUPPORTED_VERSION`, `SAMPLE_COUNT_MISMATCH`,
  `MALFORMED_BODY`.
- Helpers: `hexToBytes`, `bytesToHex`, `bytesToBinary`.

Error codes are resolved via `lib/payload-errors.ts` (mirrors the *Error Codes*
document and `scripts/002_create_payload_error_codes.sql`).

---

## Testing

```bash
npm test          # vitest run
```

`lib/payload-decoder.test.ts` covers the canonical example payload (header,
signed sample values, context, error-mask resolution) and every validation
branch.

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
