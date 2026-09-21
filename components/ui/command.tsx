'use client'

import * as React from 'react'
import { Search } from 'lucide-react'

import { cn } from '@/lib/utils'

// A searchable command list, in the shape the rest of the project's ui/
// primitives take: Command / CommandInput / CommandList / CommandEmpty /
// CommandGroup / CommandItem.
//
// Filtering is the caller's — it renders only the items that match
// `useCommandSearch()` — which keeps the list honest about what it is showing.
// Keyboard navigation walks the items that are actually rendered, read from the
// DOM, so it can never point at an item the filter has removed.

interface CommandContextValue {
  search: string
  setSearch: (value: string) => void
  registerItem: () => () => void
  itemCount: number
  listId: string
  inputId: string
}

const CommandContext = React.createContext<CommandContextValue | null>(null)

function useCommand(component: string): CommandContextValue {
  const context = React.useContext(CommandContext)
  if (!context) throw new Error(`<${component}> must be used inside <Command>`)
  return context
}

/** The current search text, for the caller doing the filtering. */
export function useCommandSearch(): string {
  return useCommand('useCommandSearch').search
}

const ITEM_SELECTOR = '[data-command-item]:not([data-disabled="true"])'

function Command({
  className,
  children,
  ...props
}: React.ComponentProps<'div'>) {
  const [search, setSearch] = React.useState('')
  const [itemCount, setItemCount] = React.useState(0)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const listId = React.useId()
  const inputId = React.useId()

  const registerItem = React.useCallback(() => {
    setItemCount((count) => count + 1)
    return () => setItemCount((count) => count - 1)
  }, [])

  const items = React.useCallback(
    () =>
      Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [],
      ),
    [],
  )

  const activate = React.useCallback(
    (element: HTMLElement | undefined) => {
      if (!element) return
      for (const item of items()) {
        const selected = item === element
        item.setAttribute('data-selected', String(selected))
        item.setAttribute('aria-selected', String(selected))
      }
      element.scrollIntoView({ block: 'nearest' })
    },
    [items],
  )

  // Keep a selection on the first match whenever the filter changes, so Enter
  // always has something to act on and never acts on a hidden row.
  React.useEffect(() => {
    const current = items()
    const selected = current.find(
      (item) => item.getAttribute('data-selected') === 'true',
    )
    if (!selected) activate(current[0])
  }, [search, itemCount, items, activate])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = items()
    if (current.length === 0) return

    const index = current.findIndex(
      (item) => item.getAttribute('data-selected') === 'true',
    )

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      activate(current[(index + 1) % current.length])
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      activate(current[(index - 1 + current.length) % current.length])
    } else if (event.key === 'Home') {
      event.preventDefault()
      activate(current[0])
    } else if (event.key === 'End') {
      event.preventDefault()
      activate(current[current.length - 1])
    } else if (event.key === 'Enter') {
      if (index === -1) return
      event.preventDefault()
      current[index].click()
    }
  }

  return (
    <CommandContext.Provider
      value={{ search, setSearch, registerItem, itemCount, listId, inputId }}
    >
      <div
        ref={rootRef}
        data-slot="command"
        onKeyDown={onKeyDown}
        className={cn(
          'flex w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </CommandContext.Provider>
  )
}

function CommandInput({
  className,
  ...props
}: Omit<React.ComponentProps<'input'>, 'value' | 'onChange'>) {
  const { search, setSearch, listId, inputId } = useCommand('CommandInput')

  return (
    <div className="flex h-9 items-center gap-2 border-b px-3">
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        id={inputId}
        data-slot="command-input"
        type="text"
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className={cn(
          'flex h-full w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  )
}

function CommandList({ className, ...props }: React.ComponentProps<'div'>) {
  const { listId } = useCommand('CommandList')
  return (
    <div
      id={listId}
      role="listbox"
      data-slot="command-list"
      className={cn('max-h-64 overflow-y-auto overflow-x-hidden p-1', className)}
      {...props}
    />
  )
}

/** Rendered only when the list holds no items — i.e. nothing matched. */
function CommandEmpty({ className, ...props }: React.ComponentProps<'div'>) {
  const { itemCount } = useCommand('CommandEmpty')
  if (itemCount > 0) return null
  return (
    <div
      data-slot="command-empty"
      className={cn('py-6 text-center text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

interface CommandGroupProps extends React.ComponentProps<'div'> {
  heading?: React.ReactNode
}

function CommandGroup({
  className,
  heading,
  children,
  ...props
}: CommandGroupProps) {
  const headingId = React.useId()
  return (
    <div
      role="group"
      aria-labelledby={heading ? headingId : undefined}
      data-slot="command-group"
      className={cn('overflow-hidden p-1 text-foreground', className)}
      {...props}
    >
      {heading && (
        <div
          id={headingId}
          className="px-2 py-1.5 text-xs font-medium text-muted-foreground"
        >
          {heading}
        </div>
      )}
      {children}
    </div>
  )
}

interface CommandItemProps extends Omit<React.ComponentProps<'div'>, 'onSelect'> {
  /** The value this item stands for; handed back to onSelect. */
  value: string
  disabled?: boolean
  onSelect?: (value: string) => void
}

function CommandItem({
  className,
  value,
  disabled,
  onSelect,
  onClick,
  ...props
}: CommandItemProps) {
  const { registerItem } = useCommand('CommandItem')

  // Counted only while mounted, so CommandEmpty reflects what the filter left.
  React.useEffect(() => registerItem(), [registerItem])

  return (
    <div
      role="option"
      aria-selected={false}
      aria-disabled={disabled || undefined}
      data-command-item=""
      data-value={value}
      data-disabled={disabled ? 'true' : undefined}
      // Pointer focus follows the mouse, the way a command list behaves.
      onPointerMove={(event) => {
        if (disabled) return
        const item = event.currentTarget
        for (const sibling of item.parentElement?.parentElement?.querySelectorAll<HTMLElement>(
          ITEM_SELECTOR,
        ) ?? []) {
          sibling.setAttribute('data-selected', String(sibling === item))
          sibling.setAttribute('aria-selected', String(sibling === item))
        }
      }}
      onClick={(event) => {
        if (disabled) return
        onClick?.(event)
        onSelect?.(value)
      }}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
}
