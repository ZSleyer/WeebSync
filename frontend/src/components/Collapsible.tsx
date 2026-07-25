import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Badge } from '@weebsync/design-system'

// Collapsible wraps a block behind its heading; the heading is the toggle
// (not persisted). `small` renders the t-label style used for sub-groups
// instead of the section heading. Shared by Suggestions and the Dashboard.
export default function Collapsible({
  title,
  count,
  children,
  defaultOpen = true,
  small = false,
}: {
  title: string
  count: number
  children: ReactNode
  defaultOpen?: boolean
  small?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const toggle = (
    <button
      type="button"
      className="flex min-h-6 items-center gap-1.5 text-left"
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
    >
      {open ? (
        <ChevronDown aria-hidden size="1em" className="shrink-0 text-accent" />
      ) : (
        <ChevronRight aria-hidden size="1em" className="shrink-0 text-accent" />
      )}
      {title} <Badge>{count}</Badge>
    </button>
  )
  return (
    <div>
      {small ? (
        <Badge tone="accent" className="mb-1 block">
          {toggle}
        </Badge>
      ) : (
        <h3 className="mb-2 font-display text-sm font-semibold tracking-wider text-t-secondary">{toggle}</h3>
      )}
      {open && children}
    </div>
  )
}
