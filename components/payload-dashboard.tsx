"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PayloadPlayground } from "@/components/payload-playground";
import { ReceivedPayloads } from "@/components/received-payloads";
import { FlaskConical, Radio, Database } from "lucide-react";

export function PayloadDashboard() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-[9000] flex h-16 items-center justify-between border-b border-border bg-white px-4 shadow-sm sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Radio className="h-5 w-5" />
          </div>
          <div className="flex flex-col border-l border-border pl-3">
            <span className="text-sm font-semibold leading-none tracking-tight text-foreground">
              Onehop Payload Platform
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              Receive, decode and inspect LoRaWAN V0 binary payloads
            </span>
          </div>
        </div>
      </header>

      <div className="flex-1 bg-muted/40 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-[1400px] space-y-6">
          <Tabs defaultValue="playground">
            <TabsList className="mb-4">
              <TabsTrigger value="playground" className="gap-2">
                <FlaskConical className="h-4 w-4" />
                Playground
              </TabsTrigger>
              <TabsTrigger value="received" className="gap-2">
                <Database className="h-4 w-4" />
                Received Payloads
              </TabsTrigger>
            </TabsList>

            <TabsContent value="playground">
              <PayloadPlayground />
            </TabsContent>

            <TabsContent value="received">
              <ReceivedPayloads />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
