'use client'

import * as React from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useClerk } from '@clerk/nextjs'
import { ArrowRight, LogOut, RefreshCw, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EnvironmentSelector } from '@/components/environment-selector'
import {
  useEnvironment,
  type EnvironmentOption,
} from '@/components/environment-provider'

/**
 * The screen between signing in and the dashboard: pick the environment the
 * session will operate in.
 *
 * Nothing here is hard-coded — the list is whatever `public.environment`
 * returned. A failure to read it is shown as a failure; it never falls through
 * into Development.
 */
export function EnvironmentSelectorPage() {
  const router = useRouter()
  const { signOut } = useClerk()
  const {
    environments,
    status,
    error,
    reload,
    selectedEnvironment,
    setSelectedEnvironment,
    clearEnvironment,
  } = useEnvironment()

  // The choice is only committed on Continue, so opening the selector to look
  // at the options cannot change the environment underneath the application.
  const [draft, setDraft] = React.useState<EnvironmentOption | null>(null)

  React.useEffect(() => {
    setDraft((current) => current ?? selectedEnvironment)
  }, [selectedEnvironment])

  const loading = status === 'loading' || status === 'idle'
  const failed = status === 'error'
  const empty = status === 'ready' && environments.length === 0

  const handleContinue = () => {
    if (!draft || !draft.supported) return
    setSelectedEnvironment(draft)
    router.replace('/')
  }

  const handleSignOut = () => {
    // The environment belongs to the session that chose it.
    clearEnvironment()
    void signOut({ redirectUrl: '/sign-in' })
  }

  return (
    <main className="flex min-h-screen flex-col bg-muted/40">
      <header className="flex h-16 items-center border-b border-border bg-white px-4 shadow-sm sm:px-6">
        <div className="flex items-center gap-3">
          <Image
            src="/energiot_aplicacoes-07.png"
            alt="Energiot"
            width={140}
            height={36}
            priority
            className="h-9 w-auto object-contain"
          />
          <div className="hidden flex-col border-l border-border pl-3 sm:flex">
            <span className="text-sm font-semibold leading-none tracking-tight text-foreground">
              Onehop Payload Platform
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              Testing platform for Onehop devices
            </span>
          </div>
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <Card className="w-full max-w-md">
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold tracking-tight text-foreground">
                Select Environment
              </h1>
              <p className="text-sm text-muted-foreground">
                Choose the environment this session will work in. It decides
                which payload dataset the whole application reads and writes.
              </p>
            </div>

            <div className="space-y-2">
              {loading && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Loading…
                </p>
              )}

              {failed && (
                <div className="space-y-3">
                  <p className="flex items-start gap-2 text-sm text-destructive">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>
                      Could not load the environments.
                      {error ? (
                        <span className="mt-1 block font-mono text-xs text-muted-foreground">
                          {error}
                        </span>
                      ) : null}
                    </span>
                  </p>
                  <Button
                    variant="outline"
                    onClick={reload}
                    className="w-full gap-2"
                  >
                    <RefreshCw className="size-4" />
                    Try again
                  </Button>
                </div>
              )}

              {empty && (
                <div className="space-y-2 py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    No environments available.
                  </p>
                  {/* The application does not invent a list, so an empty table
                      and a table the anon role cannot read look the same from
                      here. Naming both saves a debugging session. */}
                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono">public.environment</span>{" "}
                    returned no rows. If it does hold rows, the anon role has no
                    read access to it yet — run{" "}
                    <span className="font-mono">
                      scripts/006_environment_and_ree_access.sql
                    </span>
                    .
                  </p>
                </div>
              )}

              {status === 'ready' && environments.length > 0 && (
                <>
                  <EnvironmentSelector
                    environments={environments}
                    value={draft}
                    onChange={setDraft}
                  />

                  {draft && !draft.supported && (
                    <p className="flex items-start gap-2 text-xs text-destructive">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                      This application has no payload data source mapped for
                      <span className="font-mono">{draft.name}</span>, so it
                      cannot be entered.
                    </p>
                  )}

                  <Button
                    onClick={handleContinue}
                    disabled={!draft || !draft.supported}
                    className="w-full gap-2"
                  >
                    Continue
                    <ArrowRight className="size-4" />
                  </Button>
                </>
              )}

              <Button
                variant="ghost"
                onClick={handleSignOut}
                className="w-full gap-2 text-muted-foreground"
              >
                <LogOut className="size-4" />
                Sign out
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
