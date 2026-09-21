'use client'

import * as React from 'react'
import { Check, ChevronDown, Database, Layers } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  useCommandSearch,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { environmentStatusLabel } from '@/lib/environments'
import type { EnvironmentOption } from '@/components/environment-provider'

interface EnvironmentSelectorProps {
  environments: EnvironmentOption[]
  value: EnvironmentOption | null
  onChange: (environment: EnvironmentOption) => void
  disabled?: boolean
  className?: string
}

/** The circular icon in front of an environment, the way an avatar reads. */
function EnvironmentAvatar({
  production,
  className,
}: {
  production: boolean
  className?: string
}) {
  const Icon = production ? Database : Layers
  return (
    <span
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full',
        production
          ? 'bg-primary/10 text-primary'
          : 'bg-muted text-muted-foreground',
        className,
      )}
      aria-hidden
    >
      <Icon className="size-4" />
    </span>
  )
}

// Rendered inside <Command> so it can read the live search text. Only the
// environments whose name matches are rendered, which is also what makes
// CommandEmpty and the keyboard navigation agree with what is on screen.
function EnvironmentItems({
  environments,
  value,
  onChange,
}: Pick<EnvironmentSelectorProps, 'environments' | 'value' | 'onChange'>) {
  const search = useCommandSearch().trim().toLowerCase()
  const matches = environments.filter((environment) =>
    environment.name.toLowerCase().includes(search),
  )

  return (
    <CommandGroup heading="Environments">
      {matches.map((environment) => (
        <CommandItem
          key={environment.name}
          value={environment.name}
          disabled={!environment.supported}
          onSelect={() => onChange(environment)}
          className="gap-3 py-2"
        >
          <EnvironmentAvatar production={environment.production} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">
              {environment.name}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {environment.supported
                ? environmentStatusLabel(environment.production)
                : 'No data source configured'}
            </span>
          </span>
          {value?.name === environment.name && (
            <Check className="ml-auto size-4 text-primary" />
          )}
        </CommandItem>
      ))}
    </CommandGroup>
  )
}

/**
 * Picks the environment the session operates in.
 *
 * The list is whatever `public.environment` returned — this component never
 * carries its own copy — and each row shows the environment's name above its
 * Production / Development status, rendered from the `production` flag rather
 * than printing the raw boolean.
 */
export function EnvironmentSelector({
  environments,
  value,
  onChange,
  disabled,
  className,
}: EnvironmentSelectorProps) {
  const [open, setOpen] = React.useState(false)
  // Named explicitly so the combobox trigger can point aria-controls at the
  // list it opens, rather than relying on a generated id it cannot see.
  const listId = React.useId()

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      contentId={listId}
      className={className}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label="Select environment"
          aria-expanded={open}
          aria-controls={listId}
          disabled={disabled}
          className={cn(
            'flex h-14 w-full items-center gap-3 rounded-lg border border-input bg-background px-3 text-left shadow-xs outline-none transition-colors',
            'hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          {value ? (
            <>
              <EnvironmentAvatar production={value.production} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-foreground">
                  {value.name}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {environmentStatusLabel(value.production)}
                </span>
              </span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">
              Select an environment
            </span>
          )}
          <ChevronDown className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>

      <PopoverContent className="p-0">
        <Command>
          <CommandInput
            placeholder="Search environment..."
            aria-label="Search environment"
          />
          <CommandList>
            <CommandEmpty>No environments found.</CommandEmpty>
            <EnvironmentItems
              environments={environments}
              value={value}
              onChange={(environment) => {
                onChange(environment)
                setOpen(false)
              }}
            />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export { EnvironmentAvatar }

/** Small inline "REE · Production" marker for the application chrome. */
export function EnvironmentBadge({
  environment,
  className,
}: {
  environment: EnvironmentOption
  className?: string
}) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          environment.production ? 'bg-primary' : 'bg-muted-foreground/50',
        )}
        aria-hidden
      />
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-foreground">
          {environment.name}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {environmentStatusLabel(environment.production)}
        </span>
      </span>
    </span>
  )
}
