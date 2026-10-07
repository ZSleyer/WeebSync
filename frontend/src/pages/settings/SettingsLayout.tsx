import { useEffect, useState, type ReactNode } from 'react'
import {
  Activity,
  ArrowDownUp,
  Bell,
  Database,
  Info,
  Link2,
  LogOut,
  Plug,
  RefreshCw,
  Search,
  Server,
  Settings2,
  Shield,
  UserRound,
} from 'lucide-react'
import { Navigate, NavLink, Outlet, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Button, Input, navItemClass, Panel, useMediaQuery } from '@weebsync/design-system'
import { api } from '../../api'
import { useAuth, useUpdateHint } from '../../hooks'
import { WIDE_MQ } from '../../components/PageActions'
import { SectionHub, SectionNav, type SectionGroup } from '../../components/SectionNav'

const PERSONAL = [
  { to: 'general', key: 'settings.nav.general', icon: Settings2, hint: 'settings.hub.general' },
  { to: 'account', key: 'settings.nav.account', icon: UserRound, hint: 'settings.hub.account' },
  { to: 'sync', key: 'settings.nav.sync', icon: RefreshCw, hint: 'settings.hub.sync' },
  { to: 'notifications', key: 'settings.nav.notifications', icon: Bell, hint: 'settings.hub.notifications' },
]
const SOURCES = [{ to: 'servers', key: 'nav.servers', icon: Server, hint: 'settings.hub.servers' }]
// where the data comes from besides the servers: admin only
const INTEGRATIONS = [
  { to: 'integrations', key: 'settings.nav.integrations', icon: Plug, hint: 'settings.hub.integrations' },
]
const OPERATIONS = [
  { to: 'transfers', key: 'settings.nav.transfers', icon: ArrowDownUp, hint: 'settings.hub.transfers' },
  { to: 'security', key: 'settings.nav.security', icon: Shield, hint: 'settings.hub.security' },
]
const ABOUT = [{ to: 'about', key: 'settings.nav.about', icon: Info, hint: 'settings.hub.about' }]
const MAINTENANCE = [
  { to: 'jobs', key: 'settings.nav.jobs', icon: Activity, hint: 'settings.hub.jobs' },
  { to: 'matching', key: 'settings.nav.matching', icon: Link2, hint: 'settings.hub.matching' },
  { to: 'data', key: 'settings.nav.data', icon: Database, hint: 'settings.hub.data' },
]

// Panels inside a section that a search lands on directly. Each shows only
// while its section is in the menu, so a user never finds an admin panel.
export const PANELS = [
  { to: 'security#users', key: 'settings.search.users' },
  { to: 'integrations#anilist', label: 'AniList' },
  { to: 'integrations#tmdb', label: 'TMDB' },
  { to: 'integrations#tvdb', label: 'TVDB' },
  { to: 'integrations#animeschedule', label: 'AnimeSchedule' },
  { to: 'integrations#plex', key: 'settings.plex' },
  { to: 'integrations#ai', key: 'settings.ai' },
  { to: 'integrations#homeassistant', key: 'settings.homeAssistant' },
  { to: 'integrations#email', key: 'settings.email' },
  { to: 'jobs#log', key: 'settings.jobs.logs.title' },
  { to: 'data#import', key: 'legacy.title' },
]

// A filter over the menu: the sections by name and hint, and the panels
// above by name. While it holds text the matches stand in for the menu.
function SettingsSearch({ groups, children }: { groups: SectionGroup[]; children: ReactNode }) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const needle = q.trim().toLocaleLowerCase()
  const sections = groups.flatMap((g) => g.items)
  const has = (text: string) => text.toLocaleLowerCase().includes(needle)
  const hits = needle
    ? [
        ...sections
          .filter((i) => has(`${t(i.key)} ${i.hint ? t(i.hint) : ''}`))
          .map((i) => ({ to: i.to, title: t(i.key), sub: i.hint && t(i.hint), icon: i.icon })),
        ...PANELS.flatMap((p) => {
          const section = sections.find((i) => i.to === p.to.split('#')[0])
          const title = p.label ?? t(p.key!)
          return section && has(title) ? [{ to: p.to, title, sub: t(section.key), icon: section.icon }] : []
        }),
      ]
    : null
  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <Search
          aria-hidden
          size="1em"
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-t-muted"
        />
        <Input
          type="search"
          size="sm"
          className="w-full pl-8"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t('settings.search.label')}
          placeholder={t('settings.search.label')}
        />
      </div>
      {!hits ? (
        children
      ) : hits.length === 0 ? (
        <p className="text-sm text-t-muted" role="status">
          {t('settings.search.none')}
        </p>
      ) : (
        <nav aria-label={t('settings.search.results')}>
          {hits.map((h) => (
            <NavLink
              key={h.to}
              to={h.to}
              onClick={() => setQ('')}
              className={({ isActive }) => navItemClass('row', isActive)}
            >
              <h.icon aria-hidden size="1.25em" className="shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col py-2">
                <span className="truncate">{h.title}</span>
                {h.sub && <span className="truncate font-sans text-xs text-t-muted">{h.sub}</span>}
              </span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  )
}

// Client-side navigation does not scroll to a #panel by itself, and the
// panel may only render once its settings are in: look for it a few frames.
function useScrollToHash() {
  const { hash, pathname } = useLocation()
  useEffect(() => {
    if (!hash) return
    let tries = 0
    let frame = 0
    const go = () => {
      const el = document.getElementById(decodeURIComponent(hash.slice(1)))
      if (el) el.scrollIntoView({ block: 'start' })
      else if (tries++ < 60) frame = requestAnimationFrame(go)
    }
    frame = requestAnimationFrame(go)
    return () => cancelAnimationFrame(frame)
  }, [hash, pathname])
}

export function AdminRoute({ children }: { children: ReactNode }) {
  const { data: user } = useAuth()
  if (!user?.isAdmin) return <Navigate to="/settings" replace />
  return <>{children}</>
}

export function useSettingsGroups(): SectionGroup[] {
  const { data: user } = useAuth()
  const admin = !!user?.isAdmin
  // a newer build out marks the About entry, where the details are
  const update = useUpdateHint()
  return [
    { label: 'settings.groupPersonal', items: PERSONAL },
    { label: 'settings.groupSources', items: admin ? [...SOURCES, ...INTEGRATIONS] : SOURCES },
    ...(admin
      ? [
          { label: 'settings.groupOperations', items: OPERATIONS },
          { label: 'settings.groupMaintenance', items: MAINTENANCE },
        ]
      : []),
    { label: 'settings.groupAbout', items: ABOUT.map((i) => ({ ...i, alert: !!update })) },
  ]
}

// The hub at /settings: one row per section with a hint, and the account row
// with Logout. On a phone it is the screen behind the app bar's gear.
// Desktop has the side menu with the same sections, so there the
// index opens the first section instead of listing the menu a second time.
export function SettingsHub() {
  const { t } = useTranslation()
  const { data: user } = useAuth()
  const groups = useSettingsGroups()
  const wide = useMediaQuery(WIDE_MQ)
  if (wide) return <Navigate to="/settings/general" replace />
  const logout = async () => {
    try {
      await api.post('/api/auth/logout')
    } catch {
      /* drop to the login screen either way */
    }
    window.location.href = '/'
  }
  return (
    <SettingsSearch groups={groups}>
      <SectionHub
        groups={groups}
        before={
          <Panel className="flex items-center justify-between gap-3 p-3">
            <span className="min-w-0 truncate font-mono text-xs text-t-muted" title={user?.email}>
              {user?.email}
            </span>
            <Button size="sm" onClick={logout}>
              <LogOut aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
              {t('app.logout')}
            </Button>
          </Panel>
        }
      />
    </SettingsSearch>
  )
}

export default function SettingsLayout() {
  const { t } = useTranslation()
  const groups = useSettingsGroups()
  useScrollToHash()
  // no swipe between the sections: like the page swipe it fought the
  // gestures inside the page, and the menu is one tap away
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* the desktop's heading; on a phone the app bar carries the section
          title and a back link to the hub */}
      <header className="mb-6 hidden lg:block">
        <h2 className="font-display text-xl font-semibold tracking-wider">{t('settings.title')}</h2>
      </header>

      <div className="flex flex-1 flex-col gap-6 lg:flex-row">
        <div className="hidden shrink-0 lg:block lg:w-52">
          <SettingsSearch groups={groups}>
            <SectionNav label={t('settings.navLabel')} groups={groups} />
          </SettingsSearch>
        </div>

        <div className="min-w-0 max-w-4xl flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
