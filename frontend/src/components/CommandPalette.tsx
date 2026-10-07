import { useEffect, useId, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Search, Sparkles, Settings, Tv, type LucideIcon } from 'lucide-react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Dialog } from '@weebsync/design-system'
import { api, mediaTitle, type Watch } from '../api'
import { useSeriesModal } from './SeriesModal'
import { PANELS, useSettingsGroups } from '../pages/settings/SettingsLayout'
import { useSuggestionGroups } from '../pages/Suggestions'

export interface PalettePage {
  to: string
  key: string
  icon: LucideIcon
}

interface Entry {
  id: string
  label: string
  /** where it lives, under the label */
  sub: string
  icon: LucideIcon
  run: () => void
}

const RECENT_KEY = 'weebsync.palette.recent'
const readRecent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
  } catch {
    return []
  }
}

/**
 * Ctrl+K (Cmd+K) from anywhere: one field over the pages, the sections of
 * Settings and Suggestions, the panels inside Settings and the series under
 * auto-sync. An empty field lists what was opened last. A shortcut for the
 * desktop on top of the sidebar, not a replacement for it.
 */
export default function CommandPalette({
  pages,
  open,
  onOpenChange,
}: {
  pages: PalettePage[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])
  // the lists behind it load only while it is open
  return open ? <Palette pages={pages} onClose={() => onOpenChange(false)} /> : null
}

function Palette({ pages, onClose }: { pages: PalettePage[]; onClose: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { open: openSeries } = useSeriesModal()
  const settings = useSettingsGroups()
  const suggestions = useSuggestionGroups()
  const { data: watches = [] } = useQuery<Watch[]>({ queryKey: ['watches'], queryFn: () => api.get('/api/watches') })
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const listId = useId()

  const go = (to: string) => () => {
    navigate(to)
    onClose()
  }
  const sectionsOf = (base: string, groups: typeof settings, where: string): Entry[] =>
    groups.flatMap((g) =>
      g.items.map((i) => ({
        id: `${base}/${i.to}`,
        label: t(i.key),
        sub: where,
        icon: i.icon,
        run: go(`${base}/${i.to}`),
      })),
    )
  const settingSections = sectionsOf('/settings', settings, t('nav.settings'))
  const entries: Entry[] = [
    ...pages.map((p) => ({ id: p.to, label: t(p.key), sub: t('palette.page'), icon: p.icon, run: go(p.to) })),
    ...sectionsOf('/suggestions', suggestions, t('nav.suggestions')),
    ...settingSections,
    // a panel only where its section is listed: no admin panel for a user
    ...PANELS.flatMap((p) => {
      const section = settingSections.find((s) => s.id === `/settings/${p.to.split('#')[0]}`)
      return section
        ? [
            {
              id: `/settings/${p.to}`,
              label: p.label ?? t(p.key!),
              sub: `${t('nav.settings')} · ${section.label}`,
              icon: Settings,
              run: go(`/settings/${p.to}`),
            },
          ]
        : []
    }),
    ...watches
      .filter((w) => w.media)
      .map((w) => ({
        id: `watch:${w.id}`,
        label: w.titleOverride || mediaTitle(w.media, w.remotePath.split('/').pop() || ''),
        sub: t('nav.watches'),
        icon: Tv,
        run: () => {
          onClose()
          // the palette's history entry goes first, then the card pushes its
          // own: a push before that back() lands would be popped by it
          const show = () =>
            openSeries({
              source: w.mediaSource,
              id: w.media!.id,
              media: w.media!,
              watchId: w.id,
              title: w.titleOverride || undefined,
            })
          const once = () => {
            window.removeEventListener('popstate', once)
            clearTimeout(timer)
            show()
          }
          window.addEventListener('popstate', once)
          const timer = setTimeout(once, 300)
        },
      })),
  ]

  const needle = q.trim().toLocaleLowerCase()
  const shown: Entry[] = needle
    ? entries
        .map((e) => ({ e, pos: `${e.label} ${e.sub}`.toLocaleLowerCase().indexOf(needle) }))
        .filter((x) => x.pos >= 0)
        // a match at the start of the name before one further in
        .sort((a, b) => Number(a.pos !== 0) - Number(b.pos !== 0))
        .slice(0, 30)
        .map((x) => x.e)
    : readRecent().flatMap((id) => entries.filter((e) => e.id === id))
  const sel = Math.min(at, shown.length - 1)

  const run = (e: Entry) => {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify([e.id, ...readRecent().filter((r) => r !== e.id)].slice(0, 5)))
    } catch {
      // storage can be off; the palette works without recents
    }
    e.run()
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!shown.length) return
      setAt((sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length)
    } else if (e.key === 'Enter' && shown[sel]) {
      e.preventDefault()
      run(shown[sel])
    }
  }

  const optionId = (i: number) => `${listId}-${i}`
  return (
    <Dialog width="max-w-lg" sheet={false} onClose={onClose} aria-label={t('palette.title')}>
      <div className="flex items-center gap-2 border-b border-border-subtle px-4">
        <Search aria-hidden size="1.1em" className="shrink-0 text-t-muted" />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={shown[sel] ? optionId(sel) : undefined}
          aria-label={t('palette.title')}
          placeholder={t('palette.placeholder')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setAt(0)
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent py-3.5 text-sm text-t-primary outline-none placeholder:text-t-muted"
        />
        <kbd className="rounded-xs border border-border-subtle px-1.5 font-mono text-[11px] text-t-muted">Esc</kbd>
      </div>
      <div className="max-h-[min(60dvh,26rem)] overflow-y-auto p-2">
        {!needle && shown.length > 0 && (
          <p className="px-2 pt-1 pb-1.5 font-mono text-[11px] tracking-wider text-t-muted uppercase">
            {t('palette.recent')}
          </p>
        )}
        <ul id={listId} role="listbox" aria-label={t('palette.title')}>
          {shown.map((e, i) => (
            <li
              key={e.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === sel}
              onMouseMove={() => i !== sel && setAt(i)}
              onClick={() => run(e)}
              className={`flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm ${
                i === sel ? 'bg-bg-hover text-t-primary' : 'text-t-secondary'
              }`}
            >
              <e.icon aria-hidden size="1.1em" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{e.label}</span>
              <span className="shrink-0 truncate text-xs text-t-muted">{e.sub}</span>
            </li>
          ))}
        </ul>
        {needle && shown.length === 0 && (
          <p className="px-2 py-3 text-sm text-t-muted" role="status">
            {t('palette.none')}
          </p>
        )}
        {!needle && shown.length === 0 && (
          <p className="flex items-center gap-2 px-2 py-3 text-sm text-t-muted">
            <Sparkles aria-hidden size="1em" />
            {t('palette.hint')}
          </p>
        )}
      </div>
    </Dialog>
  )
}
