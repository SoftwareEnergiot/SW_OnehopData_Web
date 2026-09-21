'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'

import { useEnvironment } from '@/components/environment-provider'

/**
 * Keeps an environment-dependent page from rendering without a valid
 * environment.
 *
 * The selection lives in the browser session, so the check can only happen
 * once the provider has read it back and validated it against
 * `public.environment`. Until then the page shows the application's standard
 * loading state rather than guessing; after that, anything but a valid,
 * supported environment sends the reader to the selector.
 */
export function EnvironmentGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { selectedEnvironment, schema, resolved } = useEnvironment()
  const valid = Boolean(selectedEnvironment?.supported && schema)

  React.useEffect(() => {
    if (resolved && !valid) router.replace('/select-environment')
  }, [resolved, valid, router])

  if (!resolved || !valid) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/40">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }

  // Remounts the whole tree when the environment changes, so not one value
  // from the previous environment can survive the switch.
  return <React.Fragment key={selectedEnvironment!.name}>{children}</React.Fragment>
}
