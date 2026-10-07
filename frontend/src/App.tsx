import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  CalendarDays,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
} from 'lucide-react'
import {
  createBrowserRouter,
  createRoutesFromElements,
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  useLocation,
  useMatches,
  useNavigationType,
} from 'react-router'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AppBar, AppShell, Button, navItemClass, TabBar, useMediaQuery } from '@weebsync/design-system'
import { api, type Download } from './api'
import { useAuth, useEvents, useUpdateHint } from './hooks'
import Brand from './components/Brand'
import Logo from './components/Logo'
import { useSpeedSampler } from './speedHistory'
import Loading from './components/Loading'
import UpdateToast from './components/UpdateToast'
import ScrollMemory from './components/ScrollMemory'
import PageScroll from './components/PageScroll'
import CommandPalette from './components/CommandPalette'
import { browserAnimated, RouteTransition, routeMotion, SectionMotion, topPage } from './components/RouteTransition'
import RedirectWithQuery from './components/RedirectWithQuery'
import { AppBarActions, ShellFooter, WIDE_MQ } from './components/PageActions'
import { SeriesModalProvider } from './components/SeriesModal'
import Setup from './pages/Setup'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Files from './pages/Files'
import Trash from './pages/Trash'
import Watches from './pages/Watches'
import SuggestionsLayout, {
  BucketSection,
  DuplicatesSection,
  IgnoredSection,
  SuggestionsHub,
  UpgradesSection,
} from './pages/Suggestions'
import Assistant from './pages/Assistant'
import Rename from './pages/Rename'
import SettingsLayout, { AdminRoute, SettingsHub } from './pages/settings/SettingsLayout'
import SyncDefaults from './pages/settings/SyncDefaults'
import General from './pages/settings/General'
import About from './pages/settings/About'
import Servers from './pages/settings/Servers'
import Account from './pages/settings/Account'
import Notifications from './pages/settings/Notifications'
import Transfers from './pages/settings/Transfers'
import Security from './pages/settings/Security'
import Integrations from './pages/settings/Integrations'
import Jobs from './pages/settings/Jobs'
import Matching, { MatchesPage } from './pages/settings/Matching'
import Data, { StorePage } from './pages/settings/Data'

// The phone's tab bar holds every top-level page - no "more" sheet: a menu
// behind a button is found half as often as one in sight. Settings is the
// gear in the app bar (phone) and the foot of the sidebar (desktop); Rename
// is a tool on a folder, reached from Files.
const TABS = [
  { to: '/', key: 'nav.dashboard', icon: LayoutDashboard },
  { to: '/calendar', key: 'nav.calendar', icon: CalendarDays },
  { to: '/watches', key: 'nav.watches', icon: RefreshCw },
  { to: '/suggestions', key: 'nav.suggestions', icon: Sparkles },
  { to: '/files', key: 'nav.files', icon: FolderOpen },
]
// The phone's tab bar holds four of them; the search stands apart at its
// right end, under the thumb, and the suggestions open from the search's
// empty field instead of a tab of their own.
const PHONE_TABS = TABS.filter((n) => n.to !== '/suggestions')
const SETTINGS = { to: '/settings', key: 'nav.settings', icon: Settings }
const NAV = [...TABS, SETTINGS]
type NavEntry = (typeof NAV)[number]
const onPath = (n: NavEntry, path: string) => path === n.to || (n.to !== '/' && path.startsWith(n.to + '/'))

// Files keeps its folder in state and writes it to the URL itself, so a link
// into it from the search would be written over. A jump (navigation state
// from the search) mounts it afresh, and it starts from the link.
function FilesJump() {
  const { state } = useLocation()
  return <Files key={(state as { jump?: number } | null)?.jump ?? 0} />
}

// Root layout element of the data router. A data router (createBrowserRouter)
// is required so form pages can useBlocker() to guard unsaved changes.
function RootLayout() {
  const { data: user, isLoading } = useAuth()
  useEvents(!!user)
  useSpeedSampler(!!user)

  if (isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Loading />
      </div>
    )
  }
  if (!user) return <Login />
  if (user.isAdmin) return <AdminGate email={user.email} />
  return <Shell email={user.email} />
}

// The OIDC-only setup path has no account until the first OIDC login, so the
// wizard cannot run its later steps inline - it navigates away and picks up
// here on the way back, at the same step list it left off at. Instances that
// already have a server report onboardingDone, so upgrades never see this.
function AdminGate({ email }: { email: string }) {
  const qc = useQueryClient()
  const { data } = useQuery<{ onboardingDone?: boolean }>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
  })
  if (data?.onboardingDone === false)
    return <Setup initialStep="import" onDone={() => qc.invalidateQueries({ queryKey: ['settings'] })} />
  return <Shell email={email} />
}

/** Route meta the shell reads through useMatches(): the title key of a screen
 *  and, on a stacked screen, where its back link goes. */
export interface RouteHandle {
  title?: string
  /** where the app bar's back link goes */
  back?: string
  /** the section this screen belongs to, for the document title */
  section?: string
}
const h = (title: string, back?: string, section?: string): RouteHandle => ({ title, back, section })
const inSettings = (title: string) => h(title, '/settings', 'nav.settings')
// the lists are tabs of one page; the assistant and the ignored list are
// screens stacked on it, with a way back
const inSuggestions = (title: string) => h(title, '/suggestions', 'nav.suggestions')
const suggestionTab = (title: string) => h(title, undefined, 'nav.suggestions')

export const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<RootLayout />}>
      <Route path="/" element={<Dashboard />} handle={h('nav.dashboard')} />
      <Route path="/files" element={<FilesJump />} handle={h('nav.files')} />
      {/* the remote and local browsers merged into /files; their links keep
          the folder they pointed at */}
      <Route path="/remote" element={<RedirectWithQuery to="/files" />} />
      <Route path="/local" element={<RedirectWithQuery to="/files" rewrite={(p) => (p.set('source', 'local'), p)} />} />
      <Route path="/browser" element={<RedirectWithQuery to="/files" />} />
      <Route path="/calendar" element={<Watches calendar />} handle={h('nav.calendar')} />
      <Route path="/watches" element={<Watches />} handle={h('nav.watches')} />
      <Route path="/suggestions" element={<SuggestionsLayout />} handle={h('nav.suggestions')}>
        <Route index element={<SuggestionsHub />} />
        <Route
          path="watchlist"
          element={<BucketSection bucket="watchlist" />}
          handle={suggestionTab('suggestions.tabWatchlist')}
        />
        <Route
          path="recommended"
          element={<BucketSection bucket="recommended" />}
          handle={suggestionTab('suggestions.tabRecommended')}
        />
        <Route
          path="trending"
          element={<BucketSection bucket="trending" />}
          handle={suggestionTab('suggestions.tabTrending')}
        />
        <Route path="upgrades" element={<UpgradesSection />} handle={suggestionTab('suggestions.tabUpgrades')} />
        <Route
          path="incomplete"
          element={<BucketSection bucket="incomplete" />}
          handle={suggestionTab('suggestions.tabIncomplete')}
        />
        <Route path="duplicates" element={<DuplicatesSection />} handle={suggestionTab('suggestions.tabDuplicates')} />
        <Route path="ignored" element={<IgnoredSection />} handle={inSuggestions('suggestions.ignored')} />
        <Route path="assistant" element={<Assistant />} handle={inSuggestions('nav.assistant')} />
      </Route>
      <Route path="/assistant" element={<Navigate to="/suggestions/assistant" replace />} />
      <Route path="/plex" element={<Navigate to="/suggestions" replace />} />
      <Route path="/servers" element={<Navigate to="/settings/servers" replace />} />
      <Route path="/rename" element={<Rename />} handle={h('nav.rename', '/files', 'nav.files')} />
      <Route path="/files/trash" element={<Trash />} handle={h('trash.title', '/files', 'nav.files')} />
      <Route path="/settings" element={<SettingsLayout />} handle={h('nav.settings')}>
        <Route index element={<SettingsHub />} />
        <Route path="general" element={<General />} handle={inSettings('settings.nav.general')} />
        <Route path="look" element={<Navigate to="/settings/general" replace />} />
        <Route path="about" element={<About />} handle={inSettings('settings.nav.about')} />
        <Route path="account" element={<Account />} handle={inSettings('settings.nav.account')} />
        <Route path="sync" element={<SyncDefaults />} handle={inSettings('settings.nav.sync')} />
        <Route path="notifications" element={<Notifications />} handle={inSettings('settings.nav.notifications')} />
        <Route path="servers" element={<Servers />} handle={inSettings('nav.servers')} />
        <Route
          path="transfers"
          element={
            <AdminRoute>
              <Transfers />
            </AdminRoute>
          }
          handle={inSettings('settings.nav.transfers')}
        />
        <Route
          path="security"
          element={
            <AdminRoute>
              <Security />
            </AdminRoute>
          }
          handle={inSettings('settings.nav.security')}
        />
        <Route
          path="integrations"
          element={
            <AdminRoute>
              <Integrations />
            </AdminRoute>
          }
          handle={inSettings('settings.nav.integrations')}
        />
        <Route
          path="jobs"
          element={
            <AdminRoute>
              <Jobs />
            </AdminRoute>
          }
          handle={inSettings('settings.nav.jobs')}
        />
        <Route
          path="matching"
          element={
            <AdminRoute>
              <Matching />
            </AdminRoute>
          }
          handle={inSettings('settings.nav.matching')}
        />
        <Route
          path="matching/:server/:source"
          element={
            <AdminRoute>
              <MatchesPage />
            </AdminRoute>
          }
          handle={h('settings.nav.matching', '/settings/matching', 'nav.settings')}
        />
        <Route
          path="data"
          element={
            <AdminRoute>
              <Data />
            </AdminRoute>
          }
          handle={inSettings('settings.nav.data')}
        />
        <Route
          path="data/:store"
          element={
            <AdminRoute>
              <StorePage />
            </AdminRoute>
          }
          handle={h('settings.nav.data', '/settings/data', 'nav.settings')}
        />
        {/* merged sections: the old paths land on their panel */}
        <Route path="email" element={<Navigate to="/settings/integrations#email" replace />} />
        <Route path="users" element={<Navigate to="/settings/security#users" replace />} />
        <Route path="import" element={<Navigate to="/settings/data#import" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>,
  ),
)

/** The deepest matched route that carries a title - the screen the user is on. */
export function useScreen(): RouteHandle {
  const matches = useMatches()
  for (let i = matches.length - 1; i >= 0; i--) {
    const handle = matches[i].handle as RouteHandle | undefined
    if (handle?.title) return handle
  }
  return {}
}

// document.title per route (WCAG 2.4.2). A stacked screen names its parent
// in the middle so a tab reads "Notifications - Settings - WeebSync".
function RouteTitle() {
  const { t } = useTranslation()
  const { title, section } = useScreen()
  useEffect(() => {
    const parts = [title && t(title), section && t(section), 'WeebSync'].filter(Boolean)
    document.title = parts.join(' - ')
  }, [title, section, t])
  return null
}

function Shell({ email }: { email: string }) {
  const { t } = useTranslation()
  const location = useLocation()
  const { title, back } = useScreen()
  // the header mark lights up while something transfers; same query the
  // sampler keeps alive, so this costs no extra request
  const { data: transferring = false } = useQuery({
    queryKey: ['downloads'],
    queryFn: () => api.get<Download[]>('/api/downloads'),
    select: (ds) => ds.some((d) => d.status === 'running'),
  })
  // the app bar's actions slot, handed to pages through context; held in
  // state (not a ref) so a page mounting before the bar still portals in
  const [actions, setActions] = useState<HTMLElement | null>(null)
  // the shell's footer row, same deal: a page's action bar portals in
  const [footer, setFooter] = useState<HTMLElement | null>(null)
  const [palette, setPalette] = useState(false)
  // a newer build out: a dot on the Settings entry (the gear on a phone) and
  // a line in the rail's foot, so an admin sees it without opening Settings;
  // the About panel has the details
  const update = useUpdateHint()
  const updateText =
    update && (update.channel === 'stable' ? t('about.updateStable', { version: update.latest }) : t('about.updateDev'))

  // How the screen changes, decided once per navigation (a plain re-render
  // must not replay it). <main> is keyed on the top-level page, so it only
  // remounts - and animates - when the page changes; a move inside a page
  // (a settings section, a suggestions tab) animates the section's own
  // outlet and leaves its heading, menu and tabs standing. A back swipe the
  // browser already animated plays nothing on top.
  const wide = useMediaQuery(WIDE_MQ)
  const navType = useNavigationType()
  const prev = useRef({ path: location.pathname, back })
  const motion = useMemo(() => {
    const m = routeMotion(prev.current, { path: location.pathname, back }, wide, navType === 'REPLACE')
    prev.current = { path: location.pathname, back }
    return navType === 'POP' && browserAnimated() ? { page: '', section: '' } : m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  // No sideways swipe between the pages: it fought every horizontal gesture
  // inside them (row swipes, the calendar, the tab decks) and was the least
  // reliable of them. The tab bar is one tap away.

  const logout = async () => {
    try {
      await api.post('/api/auth/logout')
    } catch {
      /* drop to the login screen either way - the user wants out */
    }
    // full reload to the root: guarantees the app re-gates on a fresh /api/auth/me
    // (which is now 401) and wipes every cached query of the previous user -
    // a plain cache reset raced the data-router re-render and left stale content.
    window.location.href = '/'
  }

  const icon = (n: NavEntry) => <n.icon aria-hidden size="1.25em" className="shrink-0" />
  // the dot sits on the icon's corner, so it works in a row and in a stacked tab
  const dotted = (node: ReactNode, show: boolean) => (
    <span className="relative shrink-0">
      {node}
      {show && (
        <>
          <span aria-hidden className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-warn" />
          <span className="sr-only">{t('app.updateHint')}</span>
        </>
      )}
    </span>
  )

  const sidebar = (
    <aside className="sticky top-0 hidden h-dvh w-52 shrink-0 flex-col self-start border-r border-border-subtle bg-bg-secondary lg:flex">
      <div className="border-b border-border-subtle px-4 py-5">
        <h1 className="font-display text-lg font-bold tracking-[0.2em] text-t-primary">
          {/* the mark is the way home from anywhere, as on every site */}
          <Link to="/" className="rounded-xs">
            {/* folds into the mark and back out on every page change */}
            <Brand variant="rail" slogan={t('app.tagline')} replayKey={location.pathname} className="mt-3 mb-2" />
          </Link>
        </h1>
      </div>
      {/* the way into the palette, and where its shortcut is learnt */}
      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={() => setPalette(true)}
          className="flex w-full items-center gap-2 rounded-md border border-border-subtle px-3 py-1.5 text-sm text-t-muted hover:border-border-input hover:text-t-secondary"
        >
          <Search aria-hidden size="1em" className="shrink-0" />
          <span className="flex-1 text-left">{t('palette.title')}</span>
          <kbd className="font-mono text-[11px]">{/Mac|iP/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto py-3" aria-label={t('nav.main')}>
        {TABS.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) => navItemClass('sidebar', isActive)}
          >
            {icon(n)}
            {t(n.key)}
          </NavLink>
        ))}
      </nav>
      {/* settings at the foot, apart from the pages: visited rarely, but
          always in the same place */}
      <div className="py-2">
        <NavLink to={SETTINGS.to} className={({ isActive }) => navItemClass('sidebar', isActive)}>
          {dotted(icon(SETTINGS), !!update)}
          {t(SETTINGS.key)}
        </NavLink>
      </div>
      <div className="border-t border-border-subtle p-4">
        {update && (
          <Link to="/settings/about" className="mb-3 flex items-center gap-2 text-xs text-warn hover:underline">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-warn" />
            <span className="min-w-0 truncate">{updateText}</span>
          </Link>
        )}
        <p className="mb-2 truncate font-mono text-xs text-t-muted" title={email}>
          {email}
        </p>
        <Button size="sm" className="w-full" onClick={logout}>
          <LogOut aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('app.logout')}
        </Button>
      </div>
    </aside>
  )

  // the phone's top bar: back link on a stacked screen, the screen title as
  // the page's h1, and the slot pages fill with their secondary controls
  const bar = (
    <AppBar
      leading={
        back ? (
          <Link to={back} aria-label={t('nav.back')} className="t-iconbtn text-t-secondary hover:text-t-primary">
            <ArrowLeft aria-hidden size="1.25em" />
          </Link>
        ) : (
          <Link
            to="/"
            aria-label={t('nav.dashboard')}
            className="inline-flex min-h-(--ctl-h-sm) min-w-(--ctl-h-sm) items-center justify-center rounded-xs px-1 text-t-primary"
          >
            <Logo replayKey={location.pathname} className="h-5 w-auto" active={transferring} />
          </Link>
        )
      }
      title={title ? t(title) : 'WeebSync'}
      actions={
        <>
          <div ref={setActions} className="flex items-center gap-1" />
          {/* the gear on every top-level page; a stacked screen has its back
              link instead, and Settings itself needs no way into itself */}
          {!back && !onPath(SETTINGS, location.pathname) && (
            <Link
              to={SETTINGS.to}
              aria-label={t(SETTINGS.key)}
              className="t-iconbtn text-t-secondary hover:text-t-primary"
            >
              {dotted(icon(SETTINGS), !!update)}
            </Link>
          )}
        </>
      }
    />
  )

  // the phone's tab bar: every top-level page
  const tabs = (
    <TabBar aria-label={t('nav.main')}>
      <div className="flex items-center">
        <div className="flex min-w-0 flex-1">
          {PHONE_TABS.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) => navItemClass('bottomTab', isActive)}
            >
              {icon(n)}
              <span className="max-w-full truncate whitespace-nowrap">{t(n.key)}</span>
            </NavLink>
          ))}
        </div>
        {/* the search as Ctrl+K is on the desktop: its own round button at
            the bar's end, where the thumb rests */}
        <button
          type="button"
          onClick={() => setPalette(true)}
          aria-label={t('palette.title')}
          aria-haspopup="dialog"
          className="t-tabsearch"
        >
          <Search aria-hidden size="1.35em" />
        </button>
      </div>
    </TabBar>
  )

  return (
    <SectionMotion.Provider value={motion.section}>
      <AppBarActions.Provider value={actions}>
        <ShellFooter.Provider value={footer}>
          <SeriesModalProvider>
            <AppShell
              sidebar={sidebar}
              bar={bar}
              tabs={tabs}
              mainKey={topPage(location.pathname)}
              notice={<UpdateToast />}
              footer={<div ref={setFooter} className="shrink-0 empty:hidden lg:hidden" />}
              before={
                <>
                  <RouteTitle />
                  <ScrollMemory />
                  <CommandPalette pages={NAV} open={palette} onOpenChange={setPalette} />
                </>
              }
            >
              <RouteTransition cls={motion.page}>
                <Outlet />
              </RouteTransition>
              <PageScroll stacked={!!back} />
            </AppShell>
          </SeriesModalProvider>
        </ShellFooter.Provider>
      </AppBarActions.Provider>
    </SectionMotion.Provider>
  )
}
