import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ChevronRight,
  Ellipsis,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  PenLine,
  RefreshCw,
  Settings,
  Sparkles,
} from 'lucide-react'
import {
  createBrowserRouter,
  createRoutesFromElements,
  Link,
  NavLink,
  useViewTransitionState,
  Navigate,
  Outlet,
  Route,
  useLocation,
  useMatches,
} from 'react-router'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AppBar, AppShell, Badge, Button, Dialog, NavItem, navItemClass, TabBar } from '@weebsync/design-system'
import { api } from './api'
import { useAuth, useEvents, useUpdateHint } from './hooks'
import Logo from './components/Logo'
import { useSpeedSampler } from './speedHistory'
import Loading from './components/Loading'
import UpdateToast from './components/UpdateToast'
import ScrollMemory from './components/ScrollMemory'
import RedirectWithQuery from './components/RedirectWithQuery'
import { AppBarActions, ShellFooter } from './components/PageActions'
import { SeriesModalProvider } from './components/SeriesModal'
import Setup from './pages/Setup'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Files from './pages/Files'
import Watches from './pages/Watches'
import SuggestionsLayout, { BucketSection, DuplicatesSection, IgnoredSection, SuggestionsHub, UpgradesSection } from './pages/Suggestions'
import Assistant from './pages/Assistant'
import Rename from './pages/Rename'
import SettingsLayout, { AdminRoute, SettingsHub } from './pages/settings/SettingsLayout'
import SyncDefaults from './pages/settings/SyncDefaults'
import General from './pages/settings/General'
import Servers from './pages/settings/Servers'
import Account from './pages/settings/Account'
import Notifications from './pages/settings/Notifications'
import Transfers from './pages/settings/Transfers'
import Security from './pages/settings/Security'
import Integrations from './pages/settings/Integrations'
import Jobs from './pages/settings/Jobs'
import Matching from './pages/settings/Matching'
import Data from './pages/settings/Data'

// The phone's tab bar holds the daily targets; everything else lives in the
// "more" sheet. The desktop rail lists both, in this order.
const TABS = [
  { to: '/', key: 'nav.dashboard', icon: LayoutDashboard },
  { to: '/watches', key: 'nav.watches', icon: RefreshCw },
  { to: '/suggestions', key: 'nav.suggestions', icon: Sparkles },
  { to: '/files', key: 'nav.files', icon: FolderOpen },
]
const OVERFLOW = [
  { to: '/rename', key: 'nav.rename', icon: PenLine },
  { to: '/settings', key: 'nav.settings', icon: Settings },
]
const NAV = [...TABS, ...OVERFLOW]
type NavEntry = (typeof NAV)[number]
const onPath = (n: NavEntry, path: string) => path === n.to || (n.to !== '/' && path.startsWith(n.to + '/'))

// position of a path in the nav order, for direction-aware route transitions
const navIndex = (path: string) => {
  const i = NAV.findIndex((n) => onPath(n, path))
  return i < 0 ? 0 : i
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
const inSuggestions = (title: string) => h(title, '/suggestions', 'nav.suggestions')

export const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<RootLayout />}>
      <Route path="/" element={<Dashboard />} handle={h('nav.dashboard')} />
      <Route path="/files" element={<Files />} handle={h('nav.files')} />
      {/* the remote and local browsers merged into /files; their links keep
          the folder they pointed at */}
      <Route path="/remote" element={<RedirectWithQuery to="/files" />} />
      <Route path="/local" element={<RedirectWithQuery to="/files" rewrite={(p) => (p.set('source', 'local'), p)} />} />
      <Route path="/browser" element={<RedirectWithQuery to="/files" />} />
      <Route path="/watches" element={<Watches />} handle={h('nav.watches')} />
      <Route path="/suggestions" element={<SuggestionsLayout />} handle={h('nav.suggestions')}>
        <Route index element={<SuggestionsHub />} />
        <Route path="watchlist" element={<BucketSection bucket="watchlist" />} handle={inSuggestions('suggestions.tabWatchlist')} />
        <Route path="recommended" element={<BucketSection bucket="recommended" />} handle={inSuggestions('suggestions.tabRecommended')} />
        <Route path="trending" element={<BucketSection bucket="trending" />} handle={inSuggestions('suggestions.tabTrending')} />
        <Route path="upgrades" element={<UpgradesSection />} handle={inSuggestions('suggestions.tabUpgrades')} />
        <Route path="incomplete" element={<BucketSection bucket="incomplete" />} handle={inSuggestions('suggestions.tabIncomplete')} />
        <Route path="duplicates" element={<DuplicatesSection />} handle={inSuggestions('suggestions.tabDuplicates')} />
        <Route path="ignored" element={<IgnoredSection />} handle={inSuggestions('suggestions.ignored')} />
        <Route path="assistant" element={<Assistant />} handle={inSuggestions('nav.assistant')} />
      </Route>
      <Route path="/assistant" element={<Navigate to="/suggestions/assistant" replace />} />
      <Route path="/plex" element={<Navigate to="/suggestions" replace />} />
      <Route path="/servers" element={<Navigate to="/settings/servers" replace />} />
      <Route path="/rename" element={<Rename />} handle={h('nav.rename')} />
      <Route path="/settings" element={<SettingsLayout />} handle={h('nav.settings')}>
        <Route index element={<SettingsHub />} />
        <Route path="general" element={<General />} handle={inSettings('settings.nav.general')} />
        <Route path="look" element={<Navigate to="/settings/general" replace />} />
        <Route path="about" element={<Navigate to="/settings/general#about" replace />} />
        <Route path="account" element={<Account />} handle={inSettings('settings.nav.account')} />
        <Route path="sync" element={<SyncDefaults />} handle={inSettings('settings.nav.sync')} />
        <Route path="notifications" element={<Notifications />} handle={inSettings('settings.nav.notifications')} />
        <Route path="servers" element={<Servers />} handle={inSettings('nav.servers')} />
        <Route path="transfers" element={<AdminRoute><Transfers /></AdminRoute>} handle={inSettings('settings.nav.transfers')} />
        <Route path="security" element={<AdminRoute><Security /></AdminRoute>} handle={inSettings('settings.nav.security')} />
        <Route path="integrations" element={<AdminRoute><Integrations /></AdminRoute>} handle={inSettings('settings.nav.integrations')} />
        <Route path="jobs" element={<AdminRoute><Jobs /></AdminRoute>} handle={inSettings('settings.nav.jobs')} />
        <Route path="matching" element={<AdminRoute><Matching /></AdminRoute>} handle={inSettings('settings.nav.matching')} />
        <Route path="data" element={<AdminRoute><Data /></AdminRoute>} handle={inSettings('settings.nav.data')} />
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

// RouteTransition drops the animation class once the rise finished: a filled
// transform animation keeps the wrapper a containing block, which would pin
// position:fixed descendants (e.g. the browser's selection bar) to the page
// instead of the viewport. Lives inside the keyed <main>, so a navigation
// remounts it and the next animation plays from scratch.
function RouteTransition({ cls, children }: { cls: string; children: ReactNode }) {
  const [done, setDone] = useState(false)
  return (
    // the layout classes have to survive the animation class being dropped:
    // they are what lets a page claim the remaining height of <main>
    <div
      className={`flex min-h-0 flex-1 flex-col${cls && !done ? ' ' + cls : ''}`}
      onAnimationEnd={(e) => e.target === e.currentTarget && setDone(true)}
    >
      {children}
    </div>
  )
}

function Shell({ email }: { email: string }) {
  const { t } = useTranslation()
  const location = useLocation()
  const { title, back } = useScreen()
  const [moreOpen, setMoreOpen] = useState(false)
  // the app bar's actions slot, handed to pages through context; held in
  // state (not a ref) so a page mounting before the bar still portals in
  const [actions, setActions] = useState<HTMLElement | null>(null)
  // the shell's footer row, same deal: a page's action bar portals in
  const [footer, setFooter] = useState<HTMLElement | null>(null)
  const overflow = OVERFLOW
  const moreActive = overflow.some((n) => onPath(n, location.pathname))
  // a newer build out: a dot on the Settings entry (and on the More tab that
  // hides it) and a line in the rail's foot, so an admin sees it without
  // opening Settings; the About panel has the details
  const update = useUpdateHint()
  const updateText = update && (update.channel === 'stable' ? t('about.updateStable', { version: update.latest }) : t('about.updateDev'))
  // navigating (via sheet or otherwise) closes the sheet
  useEffect(() => setMoreOpen(false), [location.pathname])

  // route transition follows nav order: a lower-numbered tab enters from the
  // right (moving right→left), a higher one from the left (left→right).
  // Keyed on pathname so it's computed once per navigation - a plain re-render
  // (e.g. opening the mobile "more" sheet) must not re-flip the class and
  // replay the animation.
  // The nav links navigate inside a view transition (<main> is named in CSS);
  // then the browser animates the swap and the wrapper class stays off, or
  // both would move. Everything else (navigate(), back button, cards) still
  // gets the class animation.
  const inViewTransition = useViewTransitionState(location.pathname)
  const curNav = navIndex(location.pathname)
  const prevNav = useRef(curNav)
  const { transitionClass, navDir } = useMemo(() => {
    const dir = curNav < prevNav.current ? 'back' : curNav > prevNav.current ? 'fwd' : 'same'
    prevNav.current = curNav
    const cls = dir === 'back' ? 'anim-slide-from-right' : dir === 'fwd' ? 'anim-slide-from-left' : 'anim-t-reveal'
    return { transitionClass: inViewTransition ? '' : cls, navDir: dir }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])
  // the direction for the view transition's CSS; a layout effect, so it is on
  // <html> before the browser captures the new state
  useLayoutEffect(() => {
    document.documentElement.dataset.nav = navDir
  }, [navDir, location.pathname])

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
            WEEB<span className="text-accent">SYNC</span>
          </Link>
        </h1>
        <Badge className="mt-2">{t('app.tagline')}</Badge>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto py-3" aria-label={t('nav.main')}>
        {[...TABS, ...overflow].map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} viewTransition className={({ isActive }) => navItemClass('sidebar', isActive)}>
            {dotted(icon(n), !!update && n.to === '/settings')}
            {t(n.key)}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-border-subtle p-4">
        {update && (
          <Link to="/settings/general#about" className="mb-3 flex items-center gap-2 text-xs text-warn hover:underline">
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
            <Logo className="h-5 w-auto" />
          </Link>
        )
      }
      title={title ? t(title) : 'WeebSync'}
      actions={<div ref={setActions} className="flex items-center gap-1" />}
    />
  )

  // the phone's tab bar: primary tabs + the "more" button
  const tabs = (
    <TabBar aria-label={t('nav.main')}>
      <div className="flex">
        {TABS.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} viewTransition className={({ isActive }) => navItemClass('bottomTab', isActive)}>
            {icon(n)}
            <span className="max-w-full truncate whitespace-nowrap">{t(n.key)}</span>
          </NavLink>
        ))}
        <NavItem
          as="button"
          variant="bottomTab"
          active={moreOpen || moreActive}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          {dotted(<Ellipsis aria-hidden size="1.25em" className="shrink-0" />, !!update)}
          <span className="max-w-full truncate whitespace-nowrap">{t('nav.more')}</span>
        </NavItem>
      </div>
    </TabBar>
  )

  // the "more" sheet is a real dialog: top layer, focus, Escape, backdrop and
  // the scroll lock all come from the platform, and focus returns to the
  // button that opened it
  const more = moreOpen && (
    <Dialog width="max-w-sm" onClose={() => setMoreOpen(false)} aria-labelledby="more-title">
      <h2 id="more-title" className="sr-only">
        {t('nav.more')}
      </h2>
      <nav aria-label={t('nav.more')} className="py-1">
        {overflow.map((n) => (
          <NavLink key={n.to} to={n.to} viewTransition className={({ isActive }) => navItemClass('sheet', isActive)}>
            {dotted(icon(n), !!update && n.to === '/settings')}
            {t(n.key)}
            <ChevronRight aria-hidden size="1em" className="ml-auto shrink-0 text-t-faint" />
          </NavLink>
        ))}
      </nav>
      <div className="flex items-center justify-between gap-3 border-t border-border-subtle px-5 py-3">
        <span className="min-w-0 truncate font-mono text-xs text-t-muted" title={email}>
          {email}
        </span>
        <Button size="sm" onClick={logout}>
          <LogOut aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('app.logout')}
        </Button>
      </div>
    </Dialog>
  )

  return (
    <AppBarActions.Provider value={actions}>
      <ShellFooter.Provider value={footer}>
        <SeriesModalProvider>
        <AppShell
          sidebar={sidebar}
          bar={bar}
          tabs={tabs}
          mainKey={location.pathname}
          notice={<UpdateToast />}
          footer={<div ref={setFooter} className="shrink-0 empty:hidden lg:hidden" />}
          before={
            <>
              <RouteTitle />
              <ScrollMemory />
              {more}
            </>
          }
        >
          <RouteTransition cls={transitionClass}>
            <Outlet />
          </RouteTransition>
        </AppShell>
        </SeriesModalProvider>
      </ShellFooter.Provider>
    </AppBarActions.Provider>
  )
}
