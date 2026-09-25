"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { PayloadAnalysisView } from "@/components/payload-analysis";
import {
  analyzePayload,
  hexToBytes,
  PayloadDecodeError,
  type PayloadAnalysis,
} from "@/lib/payload-decoder";
import { useActiveEnvironment } from "@/components/environment-provider";
import { ENVIRONMENT_PARAM } from "@/lib/environments";
import { toast } from "sonner";
import { FlaskConical, Info, Send, Wand2 } from "lucide-react";

// Canonical example payloads from the protocol documents — friendly defaults so
// the playground is useful on first load. V1 and V2 are the device formats in
// the field; V0 is kept so legacy frames can still be pasted and decoded.
const V1_EXAMPLE_HEX =
  "0100124B001A2B3C4D012A000000" +
  "A068AA6AEB00F100DC00DF00BC008C02D7009001E2040000C60016FD1002DC05C8057F01" +
  "180000000057AC0FEFCDAB890C00000002000000A1FF08B7C0A80000020008200000941100000200050000";

// The V2 reference vector: the V1 example with version 2 and the power stage
// (Vin 12500 mV, UVLO 12 V short, supercaps connected, EH active) appended.
const V2_EXAMPLE_HEX =
  "0200124B001A2B3C4D012A000000" +
  "A068AA6AEB00F100DC00DF00BC008C02D7009001E2040000C60016FD1002DC05C8057F01" +
  "180000000057AC0FEFCDAB890C00000002000000A1FF08B7C0A80000020008200000941100000200050000D4300803";

const V0_EXAMPLE_HEX =
  "0005BB00DA00D700BC008C020000000000000000C60016FD100200000000BB00BA00D700BC008C020000000000000000C60016FD110200000000BB00DA00D700BC008C020000000000000000C70016FD100200000000BA00DA00D700BC008C020000000000000000C60016FD110200000000BA00DA00D700BC008B020000000000000000C60016FD1102000000001800000000000000";

const EXAMPLE_HEX = V1_EXAMPLE_HEX;

export function PayloadPlayground() {
  // Where "Send to endpoint" writes. Named explicitly on the request, so the
  // payload lands in the environment on screen and nowhere else.
  const { environment, schema } = useActiveEnvironment();

  const [hex, setHex] = useState(EXAMPLE_HEX);
  const [analysis, setAnalysis] = useState<PayloadAnalysis | null>(null);
  const [sending, setSending] = useState(false);

  const decodeLocally = (): PayloadAnalysis | null => {
    try {
      const bytes = hexToBytes(hex);
      const result = analyzePayload(bytes);
      setAnalysis(result);
      return result;
    } catch (error) {
      setAnalysis(null);
      const message =
        error instanceof PayloadDecodeError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : "Failed to decode payload";
      toast.error(message);
      return null;
    }
  };

  const handleSend = async () => {
    let bytes: Uint8Array;
    try {
      bytes = hexToBytes(hex);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Invalid hex input",
      );
      return;
    }

    setSending(true);
    try {
      const response = await fetch(
        `/api/payloads?${ENVIRONMENT_PARAM}=${encodeURIComponent(environment.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(bytes),
        },
      );
      // A request that names an environment gets a JSON answer, so a database
      // rejection — the REE device-UID constraint above all — is reported as
      // itself rather than hidden behind an accepted status.
      const result = await response.json().catch(() => null);

      if (response.ok && result?.success) {
        toast.success(
          `Stored ${result.stored} row(s) in ${result.table} (${result.environment}).`,
        );
        decodeLocally();
      } else {
        // Shown verbatim: the payload is not silently rewritten, and it is
        // never retried against another environment.
        toast.error(result?.error ?? `Endpoint rejected the payload (HTTP ${response.status})`, {
          description: [result?.details, result?.hint]
            .filter(Boolean)
            .join(" "),
          duration: 10000,
        });
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Connection error",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <FlaskConical className="h-4 w-4 text-primary" />
          <CardTitle>Manual payload test</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="hex-input">Payload (hexadecimal)</Label>
            <Textarea
              id="hex-input"
              value={hex}
              onChange={(e) => setHex(e.target.value)}
              spellCheck={false}
              className="min-h-32 font-mono text-xs"
              placeholder="0005bb00da00…"
            />
            <p className="text-xs text-muted-foreground">
              Accepts spaces, <span className="font-mono">0x</span> prefixes and{" "}
              <span className="font-mono">:</span> separators. The version byte
              selects the format: <span className="font-mono">02</span> → V2,{" "}
              <span className="font-mono">61 + 36 · N</span> bytes, N from 1 to
              5 (14 header + 36 per sample + 47 context);{" "}
              <span className="font-mono">01</span> → V1,{" "}
              <span className="font-mono">93</span> bytes (14 header + 36 sample
              + 43 context; the earlier 82- and 86-byte V1 revisions are still
              decoded); <span className="font-mono">00</span> → V0,{" "}
              <span className="font-mono">10 + 28 · N</span> bytes.
            </p>
          </div>
          {/* Where a send lands, and what the table will accept. The
              constraint is the database's; the frontend only states it. */}
          <p className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Sending stores the payload in{" "}
              <span className="font-mono">{schema.table}</span> (
              {environment.name}).
              {schema.writeDeviceUids?.length ? (
                <>
                  {" "}
                  That table only accepts payloads whose device UID is{" "}
                  <span className="font-mono">
                    {schema.writeDeviceUids.join(", ")}
                  </span>
                  ; any other UID is rejected by the database and the rejection
                  is shown here.
                </>
              ) : null}
              {!schema.capabilities.rawPayloadInspector && (
                <>
                  {" "}
                  Each sample in the report becomes one row; the raw frame
                  itself is not stored by this table.
                </>
              )}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={decodeLocally} className="gap-2">
              <Wand2 className="h-4 w-4" />
              Decode preview
            </Button>
            <Button
              onClick={handleSend}
              variant="outline"
              disabled={sending}
              className="gap-2"
            >
              <Send className="h-4 w-4" />
              {sending ? "Sending…" : `Send to ${environment.name}`}
            </Button>
            <Button
              onClick={() => setHex(V1_EXAMPLE_HEX)}
              variant="ghost"
              className="gap-2"
            >
              V1 example
            </Button>
            <Button
              onClick={() => setHex(V2_EXAMPLE_HEX)}
              variant="ghost"
              className="gap-2"
            >
              V2 example
            </Button>
            <Button
              onClick={() => setHex(V0_EXAMPLE_HEX)}
              variant="ghost"
              className="gap-2"
            >
              V0 example
            </Button>
          </div>
        </CardContent>
      </Card>

      {analysis && <PayloadAnalysisView analysis={analysis} />}
    </div>
  );
}
