import type { ReactNode } from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'
import { NavLink } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Badge, Count, navItemClass } from '@weebsync/design-system'

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

const AlertDot = () => <span aria-hidden className="size-2 shrink-0 rounded-full bg-warn" />

export interface SectionGroup {
  label: string
  items: SectionItem[]
}

// The desktop side menu of a page with sections (settings, suggestions):
// grouped links with a count on the right. Hidden below lg, where the hub
// takes over. w-52 like the app's own sidebar: at w-44 the entry
// "Benachrichtigungen" needed 9px more than it had.
export function SectionNav({ label, groups }: { label: string; groups: SectionGroup[] }) {
  const { t } = useTranslation()
  return (
    <nav aria-label={label} className="hidden shrink-0 lg:block lg:w-52">
      <div className="flex flex-col gap-5">
        {groups.map((g) => (
          <div key={g.label}>
            <Badge className="mb-1">{t(g.label)}</Badge>
            <ul className="flex flex-col gap-1">
              {g.items.map((i) => (
                <li key={i.to}>
                  <NavLink to={i.to} className={({ isActive }) => navItemClass('sidebar', isActive)}>
                    <i.icon aria-hidden size="1.25em" className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{t(i.key)}</span>
                    {i.alert && <AlertDot />}
                    {i.count != null && <Count>{i.count}</Count>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  )
}

// The phone's menu of the same sections: one row per entry with icon, label,
// hint and count. `before` is what the page puts above the groups (the
// account row of the settings hub).
export function SectionHub({ groups, before }: { groups: SectionGroup[]; before?: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-6">
      {before}
      {groups.map((g) => (
        <nav key={g.label} aria-label={t(g.label)}>
          <Badge className="mb-2">{t(g.label)}</Badge>
          <div className="border-t border-border-subtle">
            {g.items.map((i) => (
              <NavLink key={i.to} to={i.to} className={({ isActive }) => navItemClass('row', isActive)}>
                <i.icon aria-hidden size="1.25em" className="shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col py-2">
                  <span>{t(i.key)}</span>
                  {i.hint && <span className="font-sans text-xs text-t-muted">{t(i.hint)}</span>}
                </span>
                {i.alert && <AlertDot />}
                {i.count != null && <Count>{i.count}</Count>}
                <ChevronRight aria-hidden size="1em" className="shrink-0 text-t-faint" />
              </NavLink>
            ))}
          </div>
        </nav>
      ))}
    </div>
  )
}
