'use client'

import * as React from 'react'

import { cn } from '@/lib/utils'

// A small anchored popover, in the shape the rest of the project's ui/
// primitives take. The content is positioned against the trigger rather than
// portalled, which is all any popover here needs and keeps the overlay inside
// the same stacking context as the card it belongs to.

interface PopoverContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  contentId: string
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null)

function usePopover(component: string): PopoverContextValue {
  const context = React.useContext(PopoverContext)
  if (!context) {
    throw new Error(`<${component}> must be used inside <Popover>`)
  }
  return context
}

interface PopoverProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  /**
   * Id of the content element. Pass one when the trigger has to name it in
   * `aria-controls` itself; otherwise one is generated.
   */
  contentId?: string
  className?: string
  children: React.ReactNode
}

function Popover({
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  contentId: providedContentId,
  className,
  children,
}: PopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const generatedContentId = React.useId()
  const contentId = providedContentId ?? generatedContentId
  const rootRef = React.useRef<HTMLDivElement>(null)

  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [controlledOpen, onOpenChange],
  )

  // Close on a click outside the popover, and on Escape — the two gestures a
  // reader expects from any overlay.
  React.useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current
      if (root && !root.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, setOpen])

  return (
    <PopoverContext.Provider value={{ open, setOpen, contentId }}>
      <div ref={rootRef} data-slot="popover" className={cn('relative', className)}>
        {children}
      </div>
    </PopoverContext.Provider>
  )
}

interface PopoverTriggerProps extends React.ComponentProps<'button'> {
  /** Render the single child as the trigger instead of a <button> wrapper. */
  asChild?: boolean
}

function PopoverTrigger({ asChild, children, ...props }: PopoverTriggerProps) {
  const { open, setOpen, contentId } = usePopover('PopoverTrigger')

  const triggerProps = {
    'aria-expanded': open,
    'aria-controls': open ? contentId : undefined,
    'data-state': open ? 'open' : 'closed',
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      props.onClick?.(event)
      if (!event.defaultPrevented) setOpen(!open)
    },
  }

  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<Record<string, unknown>>
    return React.cloneElement(child, { ...props, ...triggerProps })
  }

  return (
    <button type="button" data-slot="popover-trigger" {...props} {...triggerProps}>
      {children}
    </button>
  )
}

interface PopoverContentProps extends React.ComponentProps<'div'> {
  align?: 'start' | 'end'
  sideOffset?: number
}

function PopoverContent({
  className,
  align = 'start',
  sideOffset = 4,
  style,
  children,
  ...props
}: PopoverContentProps) {
  const { open, contentId } = usePopover('PopoverContent')
  if (!open) return null

  return (
    <div
      id={contentId}
      data-slot="popover-content"
      style={{ marginTop: sideOffset, ...style }}
      className={cn(
        'absolute top-full z-50 w-full rounded-md border bg-popover text-popover-foreground shadow-md outline-none',
        align === 'end' ? 'right-0' : 'left-0',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
