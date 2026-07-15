import { useEffect } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from './api'
import { useAuth, useEvents } from './hooks'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Servers from './pages/Servers'
import Browser from './pages/Browser'
import Rename from './pages/Rename'
import Settings from './pages/Settings'

const NAV = [
  { to: '/', key: 'nav.dashboard', code: '01' },
  { to: '/browser', key: 'nav.browser', code: '02' },
  { to: '/servers', key: 'nav.servers', code: '03' },
  { to: '/rename', key: 'nav.rename', code: '04' },
  { to: '/settings', key: 'nav.settings', code: '05' },
]

export default function App() {
  const { t } = useTranslation()
  const { data: user, isLoading } = useAuth()
  useEvents(!!user)

  if (isLoading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <span className="t-label t-label--accent">{t('app.loading')}</span>
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
    const item = NAV.find((n) => n.to === location.pathname)
    document.title = item ? `${t(item.key)} — WeebSync` : 'WeebSync'
  }, [location.pathname, t])
  return null
}

function Shell({ email }: { email: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const location = useLocation()

  const logout = async () => {
    await api.post('/api/auth/logout')
    qc.setQueryData(['me'], null)
  }

  const navLink = (n: (typeof NAV)[number], mobile: boolean) => (
    <NavLink
      key={n.to}
      to={n.to}
      end={n.to === '/'}
      className={({ isActive }) =>
        mobile
          ? `flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 border-t-2 px-1 font-display text-[11px] ${
              isActive ? 'border-accent text-accent' : 'border-transparent text-t-muted'
            }`
          : `group flex items-center gap-3 border-l-2 px-4 py-2.5 font-display text-sm transition-colors ${
              isActive
                ? 'border-accent bg-bg-hover text-accent'
                : 'border-transparent text-t-muted hover:bg-bg-hover hover:text-t-primary'
            }`
      }
    >
      <span className={`font-mono ${mobile ? 'text-[10px]' : 'text-[10px]'} text-t-muted`}>{n.code}</span>
      {t(n.key)}
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
            <Route path="/servers" element={<Servers />} />
            <Route path="/rename" element={<Rename />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>

      {/* mobile bottom nav */}
      <nav
        className="fixed inset-x-0 bottom-0 z-50 flex border-t border-border-subtle bg-bg-secondary pb-[env(safe-area-inset-bottom)] lg:hidden"
        aria-label={t('nav.main')}
      >
        {NAV.map((n) => navLink(n, true))}
      </nav>
    </div>
  )
}
