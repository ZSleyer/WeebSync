import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { File, Folder, Search, Sparkles, Settings, Tv, X, type LucideProps } from 'lucide-react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Dialog, Kbd } from 'fluid-lycoris'
import { api, mediaTitle, type ServerInfo, type Watch } from '../api'
import { localColor, serverColor, tint, type SourceColorName } from './sourceColor'
import { useSeriesModal } from './SeriesModal'
import { filesLink } from './playLinks'
import { PANELS, useSettingsGroups } from '../pages/settings/SettingsLayout'
import { useSuggestionGroups } from '../pages/discoverGroups'
import { DISCOVER_BASE, legacyDiscoverPath } from '../discoverRoutes'
import { PALETTE_SEARCH_EVENT } from '../share'
import './palette.css'

export interface PalettePage {
  to: string
  key: string
  icon: ComponentType<LucideProps>
}

/** the kinds of hit, in the order their groups are listed while typing */
const GROUPS = ['pages', 'series', 'discover', 'settings', 'files'] as const
type Group = (typeof GROUPS)[number]
// how many hits a group shows at most; series get covers, so fewer
const GROUP_MAX: Record<Group, number> = { pages: 8, series: 6, discover: 8, settings: 10, files: 12 }

interface Entry {
  id: string
  group: Group
  label: string
  /** where it lives, under the label */
  sub: string
  /** what a query is matched against besides the label */
  find?: string
  /** a folder path after the sub; cut from its start, the end names the place */
  path?: string
  icon: ComponentType<LucideProps>
  /** a series' cover, drawn instead of the icon */
  cover?: string
  run: () => void
  /** a source's tint (server or local library) for the icon and a dot */
  tint?: SourceColorName
}

const RECENT_KEY = 'weebsync.palette.recent'
const readRecent = (): string[] => {
  try {
    // an entry from before Entdecken moved to /discover keeps its place
    return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]).map(legacyDiscoverPath)
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

/**
 * The hits for a query, grouped by kind in the fixed order of GROUPS. Inside
 * a group a match at the start of the name comes before one further in, and
 * otherwise the group keeps its own order.
 */
export function groupHits<E extends { group: Group; label: string; find?: string }>(entries: E[], needle: string) {
  return GROUPS.flatMap((g) =>
    entries
      .filter((e) => e.group === g)
      .map((e) => ({ e, pos: `${e.label} ${e.find ?? ''}`.toLocaleLowerCase().indexOf(needle) }))
      .filter((x) => x.pos >= 0)
      .sort((a, b) => Number(a.pos !== 0) - Number(b.pos !== 0))
      .slice(0, GROUP_MAX[g])
      .map((x) => x.e),
  )
}

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
  // a shared text (the /share route) opens it with the field filled
  const [prefill, setPrefill] = useState('')
  useEffect(() => {
    const onSearch = (e: Event) => {
      setPrefill(String((e as CustomEvent).detail ?? ''))
      onOpenChange(true)
    }
    window.addEventListener(PALETTE_SEARCH_EVENT, onSearch)
    return () => window.removeEventListener(PALETTE_SEARCH_EVENT, onSearch)
  }, [onOpenChange])
  // the lists behind it load only while it is open
  return open ? (
    <Palette
      pages={pages}
      initial={prefill}
      onClose={() => {
        setPrefill('')
        onOpenChange(false)
      }}
    />
  ) : null
}

function Palette({ pages, initial, onClose }: { pages: PalettePage[]; initial: string; onClose: () => void }) {
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
  const [q, setQ] = useState(initial)
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
  // an entry's `to` is relative to its page, unless it leads elsewhere
  const under = (base: string, to: string) => (to.startsWith('/') ? to : `${base}/${to}`)
  const settingSections: Entry[] = settings.flatMap((g) =>
    g.items.map((i) => ({
      id: under('/settings', i.to),
      group: 'settings' as const,
      label: t(i.key),
      sub: i.hint ? t(i.hint) : t('nav.settings'),
      find: t('nav.settings'),
      icon: i.icon,
      run: go(under('/settings', i.to)),
    })),
  )
  // the lists of Entdecken, each with how much waits in it
  const discover: Entry[] = suggestions.flatMap((g) =>
    g.items.map((i) => ({
      id: `${DISCOVER_BASE}/${i.to}`,
      group: 'discover' as const,
      label: t(i.key),
      sub: i.count ? t('palette.entries', { count: i.count }) : t(g.label),
      find: t('nav.suggestions'),
      icon: i.icon,
      run: go(`${DISCOVER_BASE}/${i.to}`),
    })),
  )
  const entries: Entry[] = [
    ...pages.map((p) => ({
      id: p.to,
      group: 'pages' as const,
      label: t(p.key),
      sub: t('palette.page'),
      icon: p.icon,
      run: go(p.to),
    })),
    ...watches
      .filter((w) => w.media)
      .map((w) => ({
        id: `watch:${w.id}`,
        group: 'series' as const,
        label: w.titleOverride || mediaTitle(w.media, w.remotePath.split('/').pop() || ''),
        sub: t('nav.watches'),
        icon: Tv,
        cover: w.media!.coverImage?.medium || w.media!.coverImage?.large || undefined,
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
    ...discover,
    ...settingSections,
    // a panel only where its section is listed: no admin panel for a user
    ...PANELS.flatMap((p) => {
      const section = settingSections.find((s) => s.id === `/settings/${p.to.split('#')[0]}`)
      return section
        ? [
            {
              id: `/settings/${p.to}`,
              group: 'settings' as const,
              label: p.label ?? t(p.key!),
              sub: `${t('nav.settings')} · ${section.label}`,
              icon: Settings,
              run: go(`/settings/${p.to}`),
            },
          ]
        : []
    }),
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
  // a file opens the folder it lies in
  const files: Entry[] =
    needle && asked.toLocaleLowerCase() === needle
      ? (found?.results ?? []).map((h) => {
          const dir = h.isDir ? h.path : h.path.slice(0, h.path.lastIndexOf('/'))
          return {
            id: `file:${h.serverId}:${h.path}`,
            group: 'files' as const,
            label: h.name,
            sub: h.serverName || t('palette.local'),
            path: dir.slice(0, dir.lastIndexOf('/')) || '/',
            icon: h.isDir ? Folder : File,
            tint: h.serverId ? serverColor(h.serverId, colors.get(h.serverId)) : localColor(),
            run: () => {
              navigate(filesLink(h.serverId, dir), { state: { jump: Date.now() } })
              onClose()
            },
          }
        })
      : []
  // the server already matched the files; they are only capped here
  const shown: Entry[] = needle
    ? [...groupHits(entries, needle), ...files.slice(0, GROUP_MAX.files)]
    : [...recent, ...discover.filter((d) => !recent.some((r) => r.id === d.id))]
  const sel = Math.min(at, shown.length - 1)

  const run = (e: Entry) => {
    // a file hit is not kept: recents are drawn from the fixed entries, so it
    // would never show and only push a real recent out of the five
    if (!e.id.startsWith('file:')) {
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify([e.id, ...readRecent().filter((r) => r !== e.id)].slice(0, 5)))
      } catch {
        // storage can be off; the palette works without recents
      }
    }
    e.run()
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!shown.length) return
      const next = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length
      setAt(next)
      // only a key moves the view: the pointer already points at what it lit
      document.getElementById(`${listId}-${next}`)?.scrollIntoView?.({ block: 'nearest' })
    } else if (e.key === 'Enter' && shown[sel]) {
      e.preventDefault()
      run(shown[sel])
    } else if (e.key === 'Delete' && !needle && sel < recent.length && shown[sel]) {
      // the keyboard's way to forget the highlighted recent entry
      e.preventDefault()
      forget(shown[sel].id)
    }
  }

  // On a phone the palette fills the screen and the keyboard covers its lower
  // part. iOS does not shrink the layout for the keyboard, so the palette
  // gives up what the visual viewport lost at the bottom and ends above it.
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

  // a new query, or a fresh opening, starts the list at its top; moving the
  // highlight by key keeps it in view. Firefox hands a reopened list the
  // closed one's scroll position (same place in the page) as the dialog
  // first lays it out, after the effects ran - so once more a frame later
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const top = () => scroller.current && (scroller.current.scrollTop = 0)
    top()
    const frame = requestAnimationFrame(top)
    return () => cancelAnimationFrame(frame)
  }, [needle])

  const optionId = (i: number) => `${listId}-${i}`
  // the heading above row i, if a new group starts there
  const headingAt = (i: number): string | null => {
    if (!needle) {
      if (i === 0 && recent.length > 0) return t('palette.recent')
      if (i === recent.length) return t('palette.discover')
      return null
    }
    const g = shown[i].group
    return i === 0 || shown[i - 1].group !== g ? t(`palette.groups.${g}`) : null
  }
  const closeLabel = t('common.close')
  return (
    // full screen with the field on top on a phone; a 640px box with key
    // hints at its foot on a desktop (palette.css)
    <Dialog
      width="pal-w"
      sheet={false}
      onClose={onClose}
      aria-label={t('palette.title')}
      className="pal-dlg"
      bodyClassName="pal-body"
    >
      <div className="pal-in">
        <Search aria-hidden size={20} className="pal-glass" />
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
          autoComplete="off"
          spellCheck={false}
        />
        {/* an X on a phone, the Escape key cap on a desktop: one button */}
        <button type="button" className="pal-x" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
          <X aria-hidden size={22} className="pal-x-icon" />
          <Kbd className="pal-x-kbd" aria-hidden>
            Esc
          </Kbd>
        </button>
      </div>
      <div ref={scroller} className="pal-list">
        <ul id={listId} role="listbox" aria-label={t('palette.title')}>
          {shown.map((e, i) => {
            const head = headingAt(i)
            const isRecent = !needle && i < recent.length
            return (
              <Fragment key={e.id}>
                {head && (
                  <li role="presentation" className="pal-g">
                    {head}
                  </li>
                )}
                <li
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === sel}
                  onMouseMove={() => i !== sel && setAt(i)}
                  onClick={() => run(e)}
                  className="pal-row"
                >
                  {e.cover ? (
                    <img src={e.cover} alt="" loading="lazy" decoding="async" className="pal-cover" />
                  ) : (
                    <span className="pal-ic">
                      <e.icon
                        aria-hidden
                        size={20}
                        className={e.tint ? 't-src' : undefined}
                        style={e.tint ? tint(e.tint) : undefined}
                      />
                    </span>
                  )}
                  {/* name above, where it lives below: the name never has to
                      share its line with a long path */}
                  <span className="pal-t">
                    <strong>{e.label}</strong>
                    <span className="pal-sub">
                      {e.tint && <span aria-hidden className="t-src-dot" style={tint(e.tint)} />}
                      <span className={e.path ? 'pal-where' : 'pal-sub-t'}>{e.sub}</span>
                      {e.path && (
                        <>
                          <span aria-hidden>·</span>
                          {/* rtl puts the ellipsis at the start, bdi keeps the path itself in order */}
                          <span dir="rtl" className="pal-path" title={e.path}>
                            <bdi>{e.path}</bdi>
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                  {isRecent && (
                    <>
                      {/* a pointer that hovers learns the key; Delete works from the field */}
                      <Kbd aria-hidden className="pal-hint">
                        {t('palette.keys.delete')}
                      </Kbd>
                      {/* a touch screen has no Delete key: the X forgets the entry,
                          the row itself still opens it */}
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={t('palette.forget', { name: e.label })}
                        title={t('palette.forget', { name: e.label })}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          forget(e.id)
                        }}
                        className="pal-forget"
                      >
                        <X aria-hidden size={18} />
                      </button>
                    </>
                  )}
                </li>
              </Fragment>
            )
          })}
        </ul>
        {needle.length >= 2 && (isFetching || asked.toLocaleLowerCase() !== needle) && (
          <p className="pal-status" role="status">
            {t('palette.searching')}
          </p>
        )}
        {needle && shown.length === 0 && !isFetching && asked.toLocaleLowerCase() === needle && (
          <p className="pal-none" role="status">
            {t('palette.none', { q: q.trim() })}
          </p>
        )}
        {!needle && shown.length === 0 && (
          <p className="pal-none">
            <Sparkles aria-hidden size={16} />
            {t('palette.hint')}
          </p>
        )}
      </div>
      <p className="pal-foot" aria-hidden>
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> {t('palette.keys.choose')}
        </span>
        <span>
          <Kbd>Enter</Kbd> {t('palette.keys.open')}
        </span>
        <span>
          <Kbd>{t('palette.keys.delete')}</Kbd> {t('palette.keys.forget')}
        </span>
      </p>
    </Dialog>
  )
}
