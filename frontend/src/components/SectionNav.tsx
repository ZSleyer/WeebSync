import type { LucideIcon } from 'lucide-react'

// One entry of a section menu: a relative route, its label and icon, an
// optional hint under the label (hub rows), an optional count and an
// optional alert dot (something in that section wants a look).
export interface SectionItem {
  to: string
  key: string
  icon: LucideIcon
  hint?: string
  count?: number
  alert?: boolean
}

export interface SectionGroup {
  label: string
  items: SectionItem[]
}
