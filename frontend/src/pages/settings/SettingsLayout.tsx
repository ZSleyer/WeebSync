import { useId, useState, type ReactNode } from 'react'
import {
  Bell,
  BookOpen,
  Download,
  HardDrive,
  Info,
  Link2,
  ListChecks,
  MonitorPlay,
  Paintbrush,
  Plug,
  RefreshCw,
  Search,
  Server,
  Shield,
  UserRound,
} from 'lucide-react'
import { Navigate, NavLink, useMatches } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, useMediaQuery } from 'fluid-lycoris'
import { api } from '../../api'
import { logout, useAuth, useUpdateHint } from '../../hooks'
import { WIDE_MQ } from '../../components/PageActions'
import { SectionOutlet } from '../../components/RouteTransition'
import { BackLink } from '../../components/BackLink'
import type { SectionGroup, SectionItem } from '../../components/SectionNav'
import type { RouteHandle } from '../../App'
import './settings.css'

// Four groups, by what a section is about: the user, the library and how it
// is filled, the places data comes from, and the instance itself.
const YOU: SectionItem[] = [
  { to: 'general', key: 'settings.nav.general', icon: Paintbrush, hint: 'settings.hub.general' },
  { to: 'account', key: 'settings.nav.account', icon: UserRound, hint: 'settings.hub.account' },
  { to: 'notifications', key: 'settings.nav.notifications', icon: Bell, hint: 'settings.hub.notifications' },
]
const SYNC: SectionItem = { to: 'sync', key: 'settings.nav.sync', icon: RefreshCw, hint: 'settings.hub.sync' }
// the library's admin half: the index and the matches
const MATCHING: SectionItem = {
  to: 'matching',
  key: 'settings.nav.matching',
  icon: Link2,
  hint: 'settings.hub.matching',
}
// a page of its own, linked from here and from the sidebar
const RULES: SectionItem = { to: '/rules', key: 'settings.nav.rules', icon: BookOpen, hint: 'settings.hub.rules' }
const CONNECTIONS: SectionItem[] = [{ to: 'servers', key: 'nav.servers', icon: Server, hint: 'settings.hub.servers' }]
// where the data comes from besides the servers: admin only
const INTEGRATIONS: SectionItem[] = [
  { to: 'integrations', key: 'settings.nav.integrations', icon: Plug, hint: 'settings.hub.integrations' },
]
const SYSTEM: SectionItem[] = [
  { to: 'downloads', key: 'settings.nav.downloads', icon: Download, hint: 'settings.hub.downloads' },
  { to: 'playback', key: 'settings.nav.playback', icon: MonitorPlay, hint: 'settings.hub.playback' },
  { to: 'security', key: 'settings.nav.security', icon: Shield, hint: 'settings.hub.security' },
  { to: 'jobs', key: 'settings.nav.jobs', icon: ListChecks, hint: 'settings.hub.jobs' },
  { to: 'data', key: 'settings.nav.data', icon: HardDrive, hint: 'settings.hub.data' },
]
const ABOUT: SectionItem = { to: 'about', key: 'settings.nav.about', icon: Info, hint: 'settings.hub.about' }

// Panels inside a section that a search lands on directly. Each shows only
// while its section is in the menu, so a user never finds an admin panel.
export const PANELS = [
  { to: 'security#users', key: 'settings.search.users' },
  { to: 'account#devices', key: 'devices.title' },
  { to: 'integrations#anilist', label: 'AniList' },
  { to: 'integrations#tmdb', label: 'TMDB' },
  { to: 'integrations#tvdb', label: 'TVDB' },
  { to: 'integrations#animeschedule', label: 'AnimeSchedule' },
  { to: 'integrations#plex', key: 'settings.plex' },
  { to: 'integrations#ai', key: 'settings.ai' },
  { to: 'integrations#homeassistant', key: 'settings.homeAssistant' },
  { to: 'integrations#email', key: 'settings.email' },
  { to: 'playback#hardware', key: 'settings.hw.title' },
  { to: 'jobs#log', key: 'settings.jobs.logs.title' },
  { to: 'data#import', key: 'legacy.title' },
]

export interface SettingsGroup extends SectionGroup {
  /** every entry is for admins: the group carries an Admin chip */
  admin?: boolean
}

/**
 * The menu narrowed to a query: sections whose name or hint holds it, and
 * the panels (a provider, the users) whose name does, under their section's
 * group. Folded for case and accents, so "uber" finds "Über".
 */
export function filterGroups(groups: SettingsGroup[], query: string, t: (key: string) => string): SettingsGroup[] {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
  const needle = fold(query.trim())
  if (!needle) return groups
  const has = (text: string) => fold(text).includes(needle)
  return groups
    .map((g) => ({
      ...g,
      items: g.items.flatMap((i) => {
        const own = has(`${t(i.key)} ${i.hint ? t(i.hint) : ''}`) ? [i] : []
        const panels = PANELS.filter((p) => p.to.split('#')[0] === i.to)
          .map((p) => ({ p, title: p.label ?? t(p.key!) }))
          .filter(({ title }) => has(title))
          .map(({ p, title }) => ({ ...i, to: p.to, key: title, hint: i.key, panel: true }))
        return [...own, ...panels]
      }),
    }))
    .filter((g) => g.items.length > 0)
}

export function AdminRoute({ children }: { children: ReactNode }) {
  const { data: user } = useAuth()
  if (!user?.isAdmin) return <Navigate to="/settings" replace />
  return <>{children}</>
}

export function useSettingsGroups(): SettingsGroup[] {
  const { data: user } = useAuth()
  const admin = !!user?.isAdmin
  // a newer build out marks the About entry, where the details are
  const update = useUpdateHint()
  const about = { ...ABOUT, alert: !!update }
  return [
    { label: 'settings.groupYou', items: YOU },
    { label: 'settings.groupLibrary', items: admin ? [SYNC, MATCHING, RULES] : [SYNC, RULES] },
    { label: 'settings.groupConnections', items: admin ? [...CONNECTIONS, ...INTEGRATIONS] : CONNECTIONS },
    { label: 'settings.groupSystem', items: admin ? [...SYSTEM, about] : [about], admin },
  ]
}

// Who is signed in and how, and the way out: at the top of the settings
// menu on a phone and on a desktop (the sidebar has no logout of its own).
export function AccountCard() {
  const { t } = useTranslation()
  const { data: user } = useAuth()
  const { data: cfg } = useQuery<{ oidcName?: string }>({
    queryKey: ['authConfig'],
    queryFn: () => api.get('/api/auth/config'),
  })
  const via = user?.hasPassword
    ? t('settings.signedInPassword')
    : t('settings.signedInVia', { name: cfg?.oidcName || 'SSO' })
  return (
    <section aria-label={t('settings.nav.account')} className="set-acc">
      <div className="t">
        <strong title={user?.email}>{user?.email}</strong>
        <span>{via}</span>
      </div>
      <Button size="sm" onClick={() => void logout()}>
        {t('app.logout')}
      </Button>
    </section>
  )
}

// The menu of sections: per group a quiet heading, then one row per section
// with its icon tile, name and hint. A row on a phone, a compact link with
// the current one tinted on a desktop.
function SettingsMenu({ groups, onPick }: { groups: SettingsGroup[]; onPick?: () => void }) {
  const { t } = useTranslation()
  const base = useId()
  return (
    <nav aria-label={t('settings.navLabel')} className="set-nav">
      {groups.map((g, gi) => (
        <div key={g.label}>
          <p className="set-g" id={`${base}-${gi}`}>
            {t(g.label)}
            {g.admin && <span className="set-adm">{t('settings.admin')}</span>}
          </p>
          <ul aria-labelledby={`${base}-${gi}`}>
            {g.items.map((i) => (
              <li key={i.to}>
                <NavLink to={i.to} onClick={onPick} end={i.to.includes('#')}>
                  <span className="ic" aria-hidden>
                    <i.icon size="1.125rem" />
                  </span>
                  <span className="t">
                    <strong>{t(i.key)}</strong>
                    {i.hint && <span>{t(i.hint)}</span>}
                  </span>
                  {i.alert && <span className="dot" aria-label={t('settings.updateDot')} role="img" />}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

// The search over the menu: it narrows the menu in place.
function SettingsSearch({ groups }: { groups: SettingsGroup[] }) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const shown = filterGroups(groups, q, t)
  return (
    <>
      <label className="set-q">
        <Search aria-hidden size="1.125rem" />
        <span className="sr-only">{t('settings.search.label')}</span>
        <input
          type="search"
          className="t-input"
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('settings.search.placeholder')}
          autoComplete="off"
        />
      </label>
      {shown.length > 0 ? (
        <SettingsMenu groups={shown} onPick={() => setQ('')} />
      ) : (
        <p className="set-none" role="status">
          {t('settings.search.none')}
        </p>
      )}
    </>
  )
}

// The hub at /settings: the account card, the search and the menu. On a
// phone it is the screen behind the app bar's gear. Desktop has the side
// column with the same menu, so there the index opens the first section.
export function SettingsHub() {
  const groups = useSettingsGroups()
  const wide = useMediaQuery(WIDE_MQ)
  if (wide) return <Navigate to="/settings/general" replace />
  return (
    <div className="set-side">
      <AccountCard />
      <SettingsSearch groups={groups} />
    </div>
  )
}

export default function SettingsLayout() {
  const { t } = useTranslation()
  const groups = useSettingsGroups()
  // the open section's name, as the h2 the panels' h3 hang under; the app
  // bar (phone) and the menu (desktop) already show it, so it is for screen
  // readers and the outline only
  const matches = useMatches()
  const handle = matches[matches.length - 1]?.handle as RouteHandle | undefined
  const section = handle?.title && handle.title !== 'nav.settings' ? t(handle.title) : null
  // no swipe between the sections: like the page swipe it fought the
  // gestures inside the page, and the menu is one tap away
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* the desktop's title row; on a phone the app bar holds the h1 */}
      <header className="set-head">
        {/* out of settings: back where they were opened from, home when
            nothing of the app is behind them (/settings opens a section) */}
        <BackLink to="/" className="mr-2 -ml-2" />
        <h1>{t('settings.title')}</h1>
      </header>
      <div className="set-wrap">
        {/* the desktop's side column; a phone shows the same in the hub */}
        <div className="set-side set-side--desk">
          <AccountCard />
          <SettingsSearch groups={groups} />
        </div>
        <div className="set-main">
          {section && <h2 className="sr-only">{section}</h2>}
          <SectionOutlet />
        </div>
      </div>
    </div>
  )
}
