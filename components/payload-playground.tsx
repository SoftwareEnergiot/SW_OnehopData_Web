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
import { toast } from "sonner";
import { FlaskConical, Send, Wand2 } from "lucide-react";

// Canonical example payloads from the protocol documents — friendly defaults so
// the playground is useful on first load. V1 is the current device format; V0
// is kept so legacy frames can still be pasted and decoded.
const V1_EXAMPLE_HEX =
  "0100124B001A2B3C4D012A000000" +
  "A068AA6AEB00F100DC00DF00BC008C02D7009001E2040000C60016FD1002DC05C8057F01" +
  "180000000057AC0FEFCDAB890C00000002000000A1FF08B7C0A80000020008200000941100000200050000";

const V0_EXAMPLE_HEX =
  "0005BB00DA00D700BC008C020000000000000000C60016FD100200000000BB00BA00D700BC008C020000000000000000C60016FD110200000000BB00DA00D700BC008C020000000000000000C70016FD100200000000BA00DA00D700BC008C020000000000000000C60016FD110200000000BA00DA00D700BC008B020000000000000000C60016FD1102000000001800000000000000";

const EXAMPLE_HEX = V1_EXAMPLE_HEX;

export function PayloadPlayground() {
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
      const response = await fetch("/api/payloads", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      });
      // The endpoint answers with a status only — no body to read. The decoded
      // view below comes from decoding the same bytes locally.
      if (response.ok) {
        toast.success(`Payload accepted (HTTP ${response.status})`);
        decodeLocally();
      } else {
        toast.error(`Endpoint rejected the payload (HTTP ${response.status})`);
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
              selects the format: <span className="font-mono">01</span> → V1,{" "}
              <span className="font-mono">93</span> bytes (14 header + 36 sample
              + 43 context; the earlier 82- and 86-byte V1 revisions are still
              decoded); <span className="font-mono">00</span> → V0,{" "}
              <span className="font-mono">10 + 28 · N</span> bytes.
            </p>
          </div>
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
              {sending ? "Sending…" : "Send to endpoint"}
            </Button>
            <Button
              onClick={() => setHex(V1_EXAMPLE_HEX)}
              variant="ghost"
              className="gap-2"
            >
              V1 example
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
