import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from './api'
import { useAuth, useEvents } from './hooks'
import Loading from './components/Loading'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Servers from './pages/Servers'
import Browser from './pages/Browser'
import Watches from './pages/Watches'
import Suggestions from './pages/Suggestions'
import Rename from './pages/Rename'
import SettingsLayout, { AdminRoute } from './pages/settings/SettingsLayout'
import Look from './pages/settings/Look'
import Notifications from './pages/settings/Notifications'
import Transfers from './pages/settings/Transfers'
import Security from './pages/settings/Security'
import Integrations from './pages/settings/Integrations'
import Smtp from './pages/settings/Smtp'
import Users from './pages/settings/Users'

const NAV = [
  { to: '/', key: 'nav.dashboard', code: '01' },
  { to: '/browser', key: 'nav.browser', code: '02' },
  { to: '/watches', key: 'nav.watches', code: '03' },
  { to: '/suggestions', key: 'nav.suggestions', code: '04' },
  { to: '/servers', key: 'nav.servers', code: '05' },
  { to: '/rename', key: 'nav.rename', code: '06' },
  { to: '/settings', key: 'nav.settings', code: '07' },
]
// mobile bottom bar: only the daily-use targets get a tab, the rest moves
// into a "more" sheet so touch targets stay wide enough
const NAV_PRIMARY = NAV.slice(0, 4)
const NAV_MORE = NAV.slice(4)

export default function App() {
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

// document.title per route (WCAG 2.4.2)
function RouteTitle() {
  const { t } = useTranslation()
  const location = useLocation()
  useEffect(() => {
    const item = NAV.find(
      (n) => n.to === location.pathname || (n.to !== '/' && location.pathname.startsWith(n.to + '/')),
    )
    document.title = item ? `${t(item.key)} — WeebSync` : 'WeebSync'
  }, [location.pathname, t])
  return null
}

function Shell({ email }: { email: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const location = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)
  const moreActive = NAV_MORE.some((n) => location.pathname === n.to || location.pathname.startsWith(n.to + '/'))
  // navigating (via sheet or otherwise) closes the sheet; Escape too
  useEffect(() => setMoreOpen(false), [location.pathname])
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
      /* drop to the login screen either way — the user wants out */
    }
    // wipe the whole cache: the next login may be a different user and must
    // not see the previous user's downloads/servers/settings
    qc.clear()
    qc.setQueryData(['me'], null)
  }

  const navLink = (n: (typeof NAV)[number], mobile: boolean) => (
    <NavLink
      key={n.to}
      to={n.to}
      end={n.to === '/'}
      className={({ isActive }) =>
        mobile
          ? `flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 border-t-2 px-0.5 font-display text-[10px] leading-tight ${
              isActive ? 'border-accent text-accent' : 'border-transparent text-t-muted'
            }`
          : `group flex items-center gap-3 border-l-2 px-4 py-2.5 font-display text-sm transition-colors ${
              isActive
                ? 'border-accent bg-bg-hover text-accent'
                : 'border-transparent text-t-muted hover:bg-bg-hover hover:text-t-primary'
            }`
      }
    >
      <span className={`font-mono ${mobile ? 'text-[9px]' : 'text-[10px]'} text-t-muted`}>{n.code}</span>
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
      <aside className="hidden w-52 shrink-0 flex-col border-r border-border-subtle bg-bg-secondary lg:flex">
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
          {t('app.logout')}
        </button>
      </header>

      <main className="min-w-0 flex-1 p-4 pb-20 lg:p-6 lg:pb-6" key={location.pathname}>
        <div className="anim-t-reveal">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/browser" element={<Browser />} />
            <Route path="/watches" element={<Watches />} />
            <Route path="/suggestions" element={<Suggestions />} />
            <Route path="/plex" element={<Navigate to="/suggestions" replace />} />
            <Route path="/servers" element={<Servers />} />
            <Route path="/rename" element={<Rename />} />
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="look" replace />} />
              <Route path="look" element={<Look />} />
              <Route path="notifications" element={<Notifications />} />
              <Route path="transfers" element={<AdminRoute><Transfers /></AdminRoute>} />
              <Route path="security" element={<AdminRoute><Security /></AdminRoute>} />
              <Route path="integrations" element={<AdminRoute><Integrations /></AdminRoute>} />
              <Route path="email" element={<AdminRoute><Smtp /></AdminRoute>} />
              <Route path="users" element={<AdminRoute><Users /></AdminRoute>} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
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
                  `flex min-h-12 items-center gap-3 px-5 font-display text-sm ${
                    isActive ? 'text-accent' : 'text-t-secondary'
                  }`
                }
              >
                <span className="font-mono text-[10px] text-t-muted">{n.code}</span>
                {t(n.key)}
              </NavLink>
            ))}
          </div>
        )}
        <div className="flex">
          {NAV_PRIMARY.map((n) => navLink(n, true))}
          <button
            className={`flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 border-t-2 px-0.5 font-display text-[10px] leading-tight ${
              moreOpen || moreActive ? 'border-accent text-accent' : 'border-transparent text-t-muted'
            }`}
            aria-expanded={moreOpen}
            aria-controls="nav-more"
            onClick={() => setMoreOpen((o) => !o)}
          >
            <span className="font-mono text-[9px] text-t-muted">⋯</span>
            <span className="max-w-full truncate whitespace-nowrap">{t('nav.more')}</span>
          </button>
        </div>
      </nav>
    </div>
  )
}
