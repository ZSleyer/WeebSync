import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
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
} from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api } from './api'
import { useAuth, useEvents } from './hooks'
import Loading from './components/Loading'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Servers from './pages/Servers'
import Remote from './pages/Remote'
import Local from './pages/Local'
import Watches from './pages/Watches'
import Suggestions from './pages/Suggestions'
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

const NAV = [
  { to: '/', key: 'nav.dashboard', icon: LayoutDashboard },
  { to: '/local', key: 'nav.local', icon: HardDrive },
  { to: '/remote', key: 'nav.remote', icon: Cloud },
  { to: '/watches', key: 'nav.watches', icon: RefreshCw },
  { to: '/suggestions', key: 'nav.suggestions', icon: Sparkles },
  { to: '/servers', key: 'nav.servers', icon: Server },
  { to: '/rename', key: 'nav.rename', icon: PenLine },
  { to: '/settings', key: 'nav.settings', icon: Settings },
]
// mobile bottom bar: only the daily-use targets get a tab, the rest moves
// into a "more" sheet so touch targets stay wide enough
const NAV_PRIMARY = NAV.slice(0, 4)
const NAV_MORE = NAV.slice(4)

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
      <div className="grid min-h-screen place-items-center">
        <Loading />
      </div>
    )
  }
  if (!user) return <Login />
  return <Shell email={user.email} />
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
    <div className={done ? undefined : cls} onAnimationEnd={(e) => e.target === e.currentTarget && setDone(true)}>
      {children}
    </div>
  )
}

function Shell({ email }: { email: string }) {
  const { t } = useTranslation()
  const location = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)
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

  const navLink = (n: (typeof NAV)[number], mobile: boolean) => (
    <NavLink
      key={n.to}
      to={n.to}
      end={n.to === '/'}
      className={({ isActive }) =>
        mobile
          ? `flex min-h-[3.33rem] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 border-t-2 px-0.5 font-display text-[0.72rem] leading-tight ${
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

  return (
    <div className="t-hatch flex min-h-screen flex-col lg:flex-row">
      <RouteTitle />
      {/* desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col self-start border-r border-border-subtle bg-bg-secondary lg:flex">
        <div className="border-b border-border-subtle px-4 py-5">
          <h1 className="font-display text-lg font-bold tracking-[0.2em] text-t-primary">
            WEEB<span className="text-accent">SYNC</span>
          </h1>
          <span className="t-label mt-2">{t('app.tagline')}</span>
        </div>
        <nav className="flex-1 py-3" aria-label={t('nav.main')}>
          {NAV.map((n) => navLink(n, false))}
        </nav>
        <div className="border-t border-border-subtle p-4">
          <p className="mb-2 truncate font-mono text-xs text-t-muted" title={email}>
            {email}
          </p>
          <button className="t-btn t-btn--sm w-full" onClick={logout}>
            <LogOut aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('app.logout')}
          </button>
        </div>
      </aside>

      {/* mobile top bar */}
      <header className="flex items-center justify-between border-b border-border-subtle bg-bg-secondary px-4 py-3 lg:hidden">
        <h1 className="font-display text-base font-bold tracking-[0.2em] text-t-primary">
          WEEB<span className="text-accent">SYNC</span>
        </h1>
        <button className="t-btn t-btn--sm" onClick={logout}>
          <LogOut aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('app.logout')}
        </button>
      </header>

      <main className="min-w-0 flex-1 overflow-x-clip p-4 pb-20 lg:p-6 lg:pb-6" key={location.pathname}>
        <RouteTransition cls={transitionClass}>
          <Outlet />
        </RouteTransition>
      </main>

      {/* mobile bottom nav: primary tabs + "more" sheet */}
      {moreOpen && <div className="fixed inset-0 z-40 lg:hidden" aria-hidden onClick={() => setMoreOpen(false)} />}
      <nav
        className="fixed inset-x-0 bottom-0 z-50 border-t border-border-subtle bg-bg-secondary pb-[env(safe-area-inset-bottom)] lg:hidden"
        aria-label={t('nav.main')}
      >
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
            className={`flex min-h-[3.33rem] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 border-t-2 px-0.5 font-display text-[0.72rem] leading-tight ${
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
      </nav>
    </div>
  )
}
