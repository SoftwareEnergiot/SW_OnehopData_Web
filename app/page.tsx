import { PayloadDashboard } from "@/components/payload-dashboard"
import { EnvironmentGuard } from "@/components/environment-guard"

export default function Home() {
  return (
    <main className="min-h-screen">
      {/* No environment selected (or one the database no longer offers) sends
          the reader to /select-environment instead of loading payloads. */}
      <EnvironmentGuard>
        <PayloadDashboard />
      </EnvironmentGuard>
    </main>
  )
}
