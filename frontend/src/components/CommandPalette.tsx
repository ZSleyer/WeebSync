import { Fragment, useEffect, useId, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { File, Folder, Search, Sparkles, Settings, Tv, X, type LucideIcon } from 'lucide-react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Count, Dialog } from '@weebsync/design-system'
import { api, mediaTitle, type ServerInfo, type Watch } from '../api'
import { localColor, serverColor, tint, type SourceColorName } from './sourceColor'
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
  /** a number at the end, e.g. how many suggestions wait in a list */
  count?: number
  /** a source's tint (server or local library) for the icon and a dot */
  tint?: SourceColorName
}

const RECENT_KEY = 'weebsync.palette.recent'
const readRecent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
  } catch {
    return []
  }
}

interface SearchHit {
  serverId: number
  serverName?: string
  path: string
  name: string
  isDir: boolean
}

/** Files at a folder; a jump remounts the page, so it starts from the link. */
export const filesLink = (serverId: number, path: string) =>
  `/files?${serverId ? `server=${serverId}` : 'source=local'}&path=${encodeURIComponent(path.replace(/^\//, ''))}`

/**
 * Ctrl+K (Cmd+K) from anywhere, or the search button in the phone's bar: one
 * field over the pages, the sections of Settings and Suggestions, the panels
 * inside Settings, the series under auto-sync and - from two characters on -
 * the files and folders in every server's index and the local library's
 * known folders. An empty field lists what was opened last.
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
  // each server's chosen tint, for its hits
  const { data: servers = [] } = useQuery<ServerInfo[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/api/servers'),
  })
  const colors = new Map(servers.map((x) => [x.id, x.color]))
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const listId = useId()
  // the indexes are asked a beat after typing stops, not per keystroke
  const [asked, setAsked] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setAsked(q.trim()), 200)
    return () => clearTimeout(id)
  }, [q])
  const { data: found, isFetching } = useQuery<{ results: SearchHit[] }>({
    queryKey: ['search', asked],
    queryFn: () => api.get(`/api/search?q=${encodeURIComponent(asked)}`),
    enabled: asked.length >= 2,
    staleTime: 30_000,
  })

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
  // the empty field: what was opened last, then what there is to discover -
  // the suggestion lists with how much waits in each and the assistant. On a
  // phone the search took the suggestions' place in the tab bar.
  // held in state, so forgetting one redraws the list
  const [recentIds, setRecentIds] = useState(readRecent)
  const forget = (id: string) => {
    const next = recentIds.filter((r) => r !== id)
    setRecentIds(next)
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    } catch {
      // storage off: forgotten for this opening only
    }
  }
  const recent = recentIds.flatMap((id) => entries.filter((e) => e.id === id))
  const discover: Entry[] = suggestions.flatMap((g) =>
    g.items.map((i) => ({
      id: `/suggestions/${i.to}`,
      label: t(i.key),
      sub: t(g.label),
      icon: i.icon,
      count: i.count,
      run: go(`/suggestions/${i.to}`),
    })),
  )
  // a file opens the folder it lies in
  const files: Entry[] =
    needle && asked.toLocaleLowerCase() === needle
      ? (found?.results ?? []).map((h) => {
          const dir = h.isDir ? h.path : h.path.slice(0, h.path.lastIndexOf('/'))
          return {
            id: `file:${h.serverId}:${h.path}`,
            label: h.name,
            sub: `${h.serverName || t('palette.local')} · ${dir.slice(0, dir.lastIndexOf('/')) || '/'}`,
            icon: h.isDir ? Folder : File,
            tint: h.serverId ? serverColor(h.serverId, colors.get(h.serverId)) : localColor(),
            run: () => {
              navigate(filesLink(h.serverId, dir), { state: { jump: Date.now() } })
              onClose()
            },
          }
        })
      : []
  const shown: Entry[] = needle
    ? [
        ...entries
          .map((e) => ({ e, pos: `${e.label} ${e.sub}`.toLocaleLowerCase().indexOf(needle) }))
          .filter((x) => x.pos >= 0)
          // a match at the start of the name before one further in
          .sort((a, b) => Number(a.pos !== 0) - Number(b.pos !== 0))
          .slice(0, 30)
          .map((x) => x.e),
        ...files,
      ]
    : [...recent, ...discover.filter((d) => !recent.some((r) => r.id === d.id))]
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
    } else if (e.key === 'Delete' && !needle && sel < recent.length && shown[sel]) {
      // the keyboard's way to forget the highlighted recent entry
      e.preventDefault()
      forget(shown[sel].id)
    }
  }

  // On a phone the box stands at the bottom, under the thumb, right above the
  // keyboard: iOS does not shrink the layout for the keyboard, so the dialog
  // is lifted by what the visual viewport lost at the bottom.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const lift = () => root.style.setProperty('--kb', `${Math.max(0, innerHeight - vv.height - vv.offsetTop)}px`)
    lift()
    vv.addEventListener('resize', lift)
    vv.addEventListener('scroll', lift)
    return () => {
      vv.removeEventListener('resize', lift)
      vv.removeEventListener('scroll', lift)
      root.style.removeProperty('--kb')
    }
  }, [])

  const optionId = (i: number) => `${listId}-${i}`
  const heading = (text: string) => (
    <li role="presentation" className="px-2 pt-2 pb-1.5 font-mono text-[11px] tracking-wider text-t-muted uppercase">
      {text}
    </li>
  )
  return (
    // a centred box on a desktop; on a phone it stands at the bottom with the
    // field last, so field and results are where the thumb is
    <Dialog
      width="max-w-lg"
      sheet={false}
      onClose={onClose}
      aria-label={t('palette.title')}
      className="max-sm:mt-auto max-sm:mb-[calc(var(--kb,0px)+var(--safe-b)+0.5rem)]"
    >
      <div className="flex flex-col">
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
            className="min-w-0 flex-1 bg-transparent py-3.5 text-base text-t-primary outline-none placeholder:text-t-muted sm:text-sm"
          />
          <kbd className="rounded-xs border border-border-subtle px-1.5 font-mono text-[11px] text-t-muted max-sm:hidden">
            Esc
          </kbd>
        </div>
        <div className="max-h-[min(60dvh,26rem)] overflow-y-auto p-2 max-sm:max-h-[min(50dvh,26rem)]">
          <ul id={listId} role="listbox" aria-label={t('palette.title')}>
            {shown.map((e, i) => (
              <Fragment key={e.id}>
                {!needle && i === 0 && recent.length > 0 && heading(t('palette.recent'))}
                {!needle && i === recent.length && heading(t('palette.discover'))}
                <li
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === sel}
                  onMouseMove={() => i !== sel && setAt(i)}
                  onClick={() => run(e)}
                  className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm ${
                    i === sel ? 'bg-bg-hover text-t-primary' : 'text-t-secondary'
                  }`}
                >
                  <e.icon
                    aria-hidden
                    size="1.1em"
                    className={`shrink-0 ${e.tint ? 't-src' : ''}`}
                    style={e.tint ? tint(e.tint) : undefined}
                  />
                  <span className="min-w-0 flex-1 truncate">{e.label}</span>
                  {e.count ? <Count className="shrink-0">{e.count}</Count> : null}
                  <span className="flex min-w-0 shrink items-center gap-1.5 truncate text-xs text-t-muted">
                    {e.tint && <span aria-hidden className="t-src-dot" style={tint(e.tint)} />}
                    <span className="truncate">{e.sub}</span>
                  </span>
                  {!needle && i < recent.length && (
                    // forgets the entry; the row itself still opens it. Out of
                    // the tab order: Delete does the same from the field
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={t('palette.forget', { name: e.label })}
                      title={t('palette.forget', { name: e.label })}
                      onClick={(ev) => {
                        ev.stopPropagation()
                        forget(e.id)
                      }}
                      className="t-iconbtn -my-1 -mr-1 shrink-0 text-t-muted hover:text-t-primary"
                    >
                      <X aria-hidden size="1em" />
                    </button>
                  )}
                </li>
              </Fragment>
            ))}
          </ul>
          {needle.length >= 2 && (isFetching || asked.toLocaleLowerCase() !== needle) && (
            <p className="px-2 py-2 text-xs text-t-muted" role="status">
              {t('palette.searching')}
            </p>
          )}
          {needle && shown.length === 0 && !isFetching && asked.toLocaleLowerCase() === needle && (
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
      </div>
    </Dialog>
  )
}
