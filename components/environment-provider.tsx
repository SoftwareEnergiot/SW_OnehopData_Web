'use client'

import * as React from 'react'
import { useAuth } from '@clerk/nextjs'

import {
  ENVIRONMENT_STORAGE_KEY,
  environmentStatusLabel,
  isSupportedEnvironment,
  type EnvironmentRecord,
} from '@/lib/environments'
import { schemaForEnvironment, type PayloadSchema } from '@/lib/payload-schemas'

/** An environment as the selector offers it. */
export interface EnvironmentOption extends EnvironmentRecord {
  /** Whether this application has a payload data source mapped for it. */
  supported: boolean
}

export type EnvironmentStatus = 'idle' | 'loading' | 'ready' | 'error'

interface EnvironmentContextValue {
  /** Every environment in `public.environment`. Never a hard-coded list. */
  environments: EnvironmentOption[]
  status: EnvironmentStatus
  /** Set when the environments could not be read. */
  error: string | null
  reload: () => void

  selectedEnvironment: EnvironmentOption | null
  setSelectedEnvironment: (environment: EnvironmentOption) => void
  clearEnvironment: () => void

  /** Metadata only — it changes what the UI says, never what it may do. */
  isProduction: boolean
  /** Exact table the active environment's payloads live in. */
  payloadTable: string | null
  /** Alias of `payloadTable`, for call sites that read better this way. */
  payloadSource: string | null
  /** Field metadata for that table (labels, units, groups, capabilities). */
  schema: PayloadSchema | null

  /**
   * True once the persisted selection has been checked against the database.
   * Routes must not decide whether to redirect before this is set, or a page
   * refresh would bounce the reader to the selector they already answered.
   */
  resolved: boolean
}

const EnvironmentContext = React.createContext<EnvironmentContextValue | null>(
  null,
)

/** Read the persisted selection. Never throws — private mode blocks access. */
function readStoredEnvironment(): string | null {
  try {
    return window.sessionStorage.getItem(ENVIRONMENT_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredEnvironment(name: string | null): void {
  try {
    if (name === null) window.sessionStorage.removeItem(ENVIRONMENT_STORAGE_KEY)
    else window.sessionStorage.setItem(ENVIRONMENT_STORAGE_KEY, name)
  } catch {
    // A selection that cannot be persisted still works for this page view.
  }
}

/**
 * Holds the environment the session is operating in.
 *
 * The choice lives in sessionStorage rather than localStorage: it belongs to
 * the browsing session, not to the browser, so closing the tab ends it and a
 * shared machine never inherits someone else's production context. It is
 * validated against `public.environment` on every load, and cleared the moment
 * it names something the database no longer offers — never silently swapped for
 * another environment.
 */
export function EnvironmentProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const { isLoaded, isSignedIn } = useAuth()

  const [environments, setEnvironments] = React.useState<EnvironmentOption[]>([])
  const [status, setStatus] = React.useState<EnvironmentStatus>('idle')
  const [error, setError] = React.useState<string | null>(null)
  const [selectedName, setSelectedName] = React.useState<string | null>(null)
  const [resolved, setResolved] = React.useState(false)
  const [reloadKey, setReloadKey] = React.useState(0)

  // Rehydrate before the first fetch resolves, so the selection is not lost on
  // a refresh. It is not trusted yet — the fetch below validates it.
  React.useEffect(() => {
    setSelectedName(readStoredEnvironment())
  }, [])

  React.useEffect(() => {
    if (!isLoaded) return
    if (!isSignedIn) {
      // Signed out: the environments are behind auth, and any selection made
      // by a previous session must not survive into the next one.
      setEnvironments([])
      setStatus('idle')
      setError(null)
      setSelectedName(null)
      writeStoredEnvironment(null)
      setResolved(true)
      return
    }

    let cancelled = false
    setStatus('loading')
    setError(null)

    fetch('/api/environments', { cache: 'no-store' })
      .then(async (response) => {
        const result = await response.json().catch(() => null)
        if (cancelled) return

        if (!response.ok || !result?.success) {
          setEnvironments([])
          setStatus('error')
          setError(
            result?.details ??
              result?.error ??
              `Could not read the environments (HTTP ${response.status}).`,
          )
          setResolved(true)
          return
        }

        const list: EnvironmentOption[] = result.environments ?? []
        setEnvironments(list)
        setStatus('ready')

        // Drop a persisted selection the database no longer offers, or that
        // this application has no data source for. Clearing it sends the
        // reader back to the selector; it is never replaced with another one.
        setSelectedName((current) => {
          if (current === null) return null
          const match = list.find((item) => item.name === current)
          if (match && match.supported && isSupportedEnvironment(match.name)) {
            return current
          }
          writeStoredEnvironment(null)
          return null
        })
        setResolved(true)
      })
      .catch((cause) => {
        if (cancelled) return
        setEnvironments([])
        setStatus('error')
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not read the environments.',
        )
        setResolved(true)
      })

    return () => {
      cancelled = true
    }
  }, [isLoaded, isSignedIn, reloadKey])

  const setSelectedEnvironment = React.useCallback(
    (environment: EnvironmentOption) => {
      writeStoredEnvironment(environment.name)
      setSelectedName(environment.name)
    },
    [],
  )

  const clearEnvironment = React.useCallback(() => {
    writeStoredEnvironment(null)
    setSelectedName(null)
  }, [])

  const reload = React.useCallback(() => setReloadKey((key) => key + 1), [])

  const selectedEnvironment = React.useMemo(
    () => environments.find((item) => item.name === selectedName) ?? null,
    [environments, selectedName],
  )

  const schema = React.useMemo(
    () => schemaForEnvironment(selectedEnvironment?.name),
    [selectedEnvironment],
  )

  const value = React.useMemo<EnvironmentContextValue>(
    () => ({
      environments,
      status,
      error,
      reload,
      selectedEnvironment,
      setSelectedEnvironment,
      clearEnvironment,
      isProduction: selectedEnvironment?.production ?? false,
      payloadTable: schema?.table ?? null,
      payloadSource: schema?.table ?? null,
      schema,
      resolved,
    }),
    [
      environments,
      status,
      error,
      reload,
      selectedEnvironment,
      setSelectedEnvironment,
      clearEnvironment,
      schema,
      resolved,
    ],
  )

  return (
    <EnvironmentContext.Provider value={value}>
      {children}
    </EnvironmentContext.Provider>
  )
}

export function useEnvironment(): EnvironmentContextValue {
  const context = React.useContext(EnvironmentContext)
  if (!context) {
    throw new Error('useEnvironment() must be used inside <EnvironmentProvider>')
  }
  return context
}

/**
 * The active environment, for a component that cannot render without one.
 * Throws rather than guessing — every such component sits behind the route
 * guard, which redirects when there is no valid selection.
 */
export function useActiveEnvironment(): {
  environment: EnvironmentOption
  schema: PayloadSchema
  table: string
  isProduction: boolean
} {
  const { selectedEnvironment, schema } = useEnvironment()
  if (!selectedEnvironment || !schema) {
    throw new Error('No environment is selected.')
  }
  return {
    environment: selectedEnvironment,
    schema,
    table: schema.table,
    isProduction: selectedEnvironment.production,
  }
}

export { environmentStatusLabel }
