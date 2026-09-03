import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Bot,
  Cloud,
  Ellipsis,
  HardDrive,
  LayoutDashboard,
  LogOut,
  PenLine,
  RefreshCw,
  Server,
  Settings,
  Sparkles,
} from 'lucide-react'
import {
  createBrowserRouter,
  createRoutesFromElements,
  NavLink,
  Navigate,
  Outlet,
  Route,
  useLocation,
} from 'react-router'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AppBar, AppShell, Badge, Button, TabBar } from '@weebsync/design-system'
import { api } from './api'
import { useAiStatus, useAuth, useEvents } from './hooks'
import Loading from './components/Loading'
import UpdateToast from './components/UpdateToast'
import Setup from './pages/Setup'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Servers from './pages/Servers'
import Remote from './pages/Remote'
import Local from './pages/Local'
import Watches from './pages/Watches'
import Suggestions from './pages/Suggestions'
import Assistant from './pages/Assistant'
import Rename from './pages/Rename'
import SettingsLayout, { AdminRoute } from './pages/settings/SettingsLayout'
import Look from './pages/settings/Look'
import Account from './pages/settings/Account'
import About from './pages/settings/About'
import Notifications from './pages/settings/Notifications'
import Transfers from './pages/settings/Transfers'
import Security from './pages/settings/Security'
import Integrations from './pages/settings/Integrations'
import Smtp from './pages/settings/Smtp'
import Users from './pages/settings/Users'
import Jobs from './pages/settings/Jobs'
import Import from './pages/settings/Import'

const NAV = [
  { to: '/', key: 'nav.dashboard', icon: LayoutDashboard },
  { to: '/local', key: 'nav.local', icon: HardDrive },
  { to: '/remote', key: 'nav.remote', icon: Cloud },
  { to: '/watches', key: 'nav.watches', icon: RefreshCw },
  { to: '/suggestions', key: 'nav.suggestions', icon: Sparkles },
  { to: '/assistant', key: 'nav.assistant', icon: Bot },
  { to: '/servers', key: 'nav.servers', icon: Server },
  { to: '/rename', key: 'nav.rename', icon: PenLine },
  { to: '/settings', key: 'nav.settings', icon: Settings },
]
// mobile bottom bar: only the daily-use targets get a tab, the rest moves
// into a "more" sheet so touch targets stay wide enough
const NAV_PRIMARY = NAV.slice(0, 4)

// position of a path in the nav order, for direction-aware route transitions
const navIndex = (path: string) => {
  const i = NAV.findIndex((n) => n.to === path || (n.to !== '/' && path.startsWith(n.to + '/')))
  return i < 0 ? 0 : i
}

// Root layout element of the data router. A data router (createBrowserRouter)
// is required so form pages can useBlocker() to guard unsaved changes.
function RootLayout() {
  const { data: user, isLoading } = useAuth()
  useEvents(!!user)

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

export const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<RootLayout />}>
      <Route path="/" element={<Dashboard />} />
      <Route path="/remote" element={<Remote />} />
      {/* the page was called "browser" until it got a local counterpart */}
      <Route path="/browser" element={<Navigate to="/remote" replace />} />
      <Route path="/watches" element={<Watches />} />
      <Route path="/suggestions" element={<Suggestions />} />
      <Route path="/assistant" element={<Assistant />} />
      <Route path="/plex" element={<Navigate to="/suggestions" replace />} />
      <Route path="/servers" element={<Servers />} />
      <Route path="/local" element={<Local />} />
      <Route path="/rename" element={<Rename />} />
      <Route path="/settings" element={<SettingsLayout />}>
        <Route index element={<Navigate to="look" replace />} />
        <Route path="look" element={<Look />} />
        <Route path="account" element={<Account />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="about" element={<About />} />
        <Route path="transfers" element={<AdminRoute><Transfers /></AdminRoute>} />
        <Route path="security" element={<AdminRoute><Security /></AdminRoute>} />
        <Route path="integrations" element={<AdminRoute><Integrations /></AdminRoute>} />
        <Route path="email" element={<AdminRoute><Smtp /></AdminRoute>} />
        <Route path="users" element={<AdminRoute><Users /></AdminRoute>} />
        <Route path="jobs" element={<AdminRoute><Jobs /></AdminRoute>} />
        <Route path="import" element={<AdminRoute><Import /></AdminRoute>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>,
  ),
)

// document.title per route (WCAG 2.4.2)
function RouteTitle() {
  const { t } = useTranslation()
  const location = useLocation()
  useEffect(() => {
    const item = NAV.find(
      (n) => n.to === location.pathname || (n.to !== '/' && location.pathname.startsWith(n.to + '/')),
    )
    document.title = item ? `${t(item.key)} - WeebSync` : 'WeebSync'
  }, [location.pathname, t])
  return null
}

// RouteTransition drops the animation class once the wipe finished: a filled
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
      className={`flex min-h-0 flex-1 flex-col${done ? '' : ' ' + cls}`}
      onAnimationEnd={(e) => e.target === e.currentTarget && setDone(true)}
    >
      {children}
    </div>
  )
}

function Shell({ email }: { email: string }) {
  const { t } = useTranslation()
  const location = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)
  // the assistant is optional: without a configured endpoint its entry stays
  // out of the rail and the sheet (the page itself explains when opened directly)
  const { data: aiStatus } = useAiStatus()
  const nav = aiStatus?.configured ? NAV : NAV.filter((n) => n.to !== '/assistant')
  const NAV_MORE = nav.slice(4)
  const moreActive = NAV_MORE.some((n) => location.pathname === n.to || location.pathname.startsWith(n.to + '/'))
  // navigating (via sheet or otherwise) closes the sheet; Escape too
  useEffect(() => setMoreOpen(false), [location.pathname])

  // route transition follows nav order: a lower-numbered tab enters from the
  // right (moving right→left), a higher one from the left (left→right).
  // Keyed on pathname so it's computed once per navigation - a plain re-render
  // (e.g. opening the mobile "more" sheet) must not re-flip the class and
  // replay the animation.
  const curNav = navIndex(location.pathname)
  const prevNav = useRef(curNav)
  const transitionClass = useMemo(() => {
    const cls =
      curNav < prevNav.current ? 'anim-slide-from-right' : curNav > prevNav.current ? 'anim-slide-from-left' : 'anim-t-reveal'
    prevNav.current = curNav
    return cls
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])
  useEffect(() => {
    if (!moreOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMoreOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [moreOpen])

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

  // hand-written, not navItemClass(): the shell's rail and tab bar carry more
  // than the design system's sidebar/bottomTab variants - a wider icon gap and
  // taller rows on the rail, a 3.33rem touch target plus truncation on the tab
  // bar. Migrating them would shrink the touch targets.
  const navLink = (n: (typeof NAV)[number], mobile: boolean) => (
    <NavLink
      key={n.to}
      to={n.to}
      end={n.to === '/'}
      className={({ isActive }) =>
        mobile
          ? `flex min-h-(--nav-h) min-w-0 flex-1 flex-col items-center justify-center gap-0.5 border-t-2 px-0.5 font-display text-[0.72rem] leading-tight ${
              isActive ? 'border-accent text-accent' : 'border-transparent text-t-muted'
            }`
          : `group flex items-center gap-3 border-l-2 px-4 py-2.5 font-display text-sm transition-colors ${
              isActive
                ? 'border-accent bg-bg-hover text-accent'
                : 'border-transparent text-t-muted hover:bg-bg-hover hover:text-t-primary'
            }`
      }
    >
      <n.icon aria-hidden size="1.25em" className="shrink-0" />
      {mobile ? (
        <span className="max-w-full truncate whitespace-nowrap">{t(n.key)}</span>
      ) : (
        t(n.key)
      )}
    </NavLink>
  )

  const sidebar = (
    <aside className="sticky top-0 hidden h-dvh w-52 shrink-0 flex-col self-start border-r border-border-subtle bg-bg-secondary lg:flex">
      <div className="border-b border-border-subtle px-4 py-5">
        <h1 className="font-display text-lg font-bold tracking-[0.2em] text-t-primary">
          WEEB<span className="text-accent">SYNC</span>
        </h1>
        <Badge className="mt-2">{t('app.tagline')}</Badge>
      </div>
      <nav className="flex-1 py-3" aria-label={t('nav.main')}>
        {nav.map((n) => navLink(n, false))}
      </nav>
      <div className="border-t border-border-subtle p-4">
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

  const bar = (
    <AppBar>
      <h1 className="font-display text-base font-bold tracking-[0.2em] text-t-primary">
        WEEB<span className="text-accent">SYNC</span>
      </h1>
      <Button size="sm" onClick={logout}>
        <LogOut aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
        {t('app.logout')}
      </Button>
    </AppBar>
  )

  // the phone's tab bar: primary tabs + "more" sheet
  const tabs = (
    <TabBar aria-label={t('nav.main')}>
      {moreOpen && (
        <div id="nav-more" className="border-b border-border-subtle">
          {NAV_MORE.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `flex min-h-14 items-center gap-3 px-5 font-display text-sm ${
                  isActive ? 'text-accent' : 'text-t-secondary'
                }`
              }
            >
              <n.icon aria-hidden size="1.25em" className="shrink-0" />
              {t(n.key)}
            </NavLink>
          ))}
        </div>
      )}
      <div className="flex">
        {NAV_PRIMARY.map((n) => navLink(n, true))}
        <button
          className={`flex min-h-(--nav-h) min-w-0 flex-1 flex-col items-center justify-center gap-0.5 border-t-2 px-0.5 font-display text-[0.72rem] leading-tight ${
            moreOpen || moreActive ? 'border-accent text-accent' : 'border-transparent text-t-muted'
          }`}
          aria-expanded={moreOpen}
          aria-controls="nav-more"
          onClick={() => setMoreOpen((o) => !o)}
        >
          <Ellipsis aria-hidden size="1.25em" className="shrink-0" />
          <span className="max-w-full truncate whitespace-nowrap">{t('nav.more')}</span>
        </button>
      </div>
    </TabBar>
  )

  return (
    <AppShell
      sidebar={sidebar}
      bar={bar}
      tabs={tabs}
      mainKey={location.pathname}
      before={
        <>
          <RouteTitle />
          <UpdateToast />
          {/* closes the "more" sheet on a tap anywhere else */}
          {moreOpen && <div className="fixed inset-0 z-40 lg:hidden" aria-hidden onClick={() => setMoreOpen(false)} />}
        </>
      }
    >
      <RouteTransition cls={transitionClass}>
        <Outlet />
      </RouteTransition>
    </AppShell>
  )
}
