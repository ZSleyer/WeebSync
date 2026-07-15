import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import { useAuth, useEvents } from './hooks'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Servers from './pages/Servers'
import Browser from './pages/Browser'
import Rename from './pages/Rename'
import Settings from './pages/Settings'

const NAV = [
  { to: '/', label: 'Dashboard', code: '01' },
  { to: '/browser', label: 'Browser', code: '02' },
  { to: '/servers', label: 'Server', code: '03' },
  { to: '/rename', label: 'Rename', code: '04' },
  { to: '/settings', label: 'Settings', code: '05' },
]

export default function App() {
  const { data: user, isLoading } = useAuth()
  useEvents(!!user)

  if (isLoading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <span className="t-label t-label--accent">loading</span>
      </div>
    )
  }
  if (!user) return <Login />
  return <Shell email={user.email} />
}

function Shell({ email }: { email: string }) {
  const qc = useQueryClient()
  const location = useLocation()

  const logout = async () => {
    await api.post('/api/auth/logout')
    qc.setQueryData(['me'], null)
  }

  return (
    <div className="t-hatch flex min-h-screen">
      <aside className="flex w-52 shrink-0 flex-col border-r border-border-subtle bg-bg-secondary">
        <div className="border-b border-border-subtle px-4 py-5">
          <h1 className="font-display text-lg font-bold tracking-[0.2em] text-t-primary">
            WEEB<span className="text-accent">SYNC</span>
          </h1>
          <span className="t-label mt-2">s/ftp anime sync</span>
        </div>
        <nav className="flex-1 py-3" aria-label="Hauptnavigation">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                `group flex items-center gap-3 border-l-2 px-4 py-2.5 font-display text-sm transition-colors ${
                  isActive
                    ? 'border-accent bg-bg-hover text-accent'
                    : 'border-transparent text-t-muted hover:bg-bg-hover hover:text-t-primary'
                }`
              }
            >
              <span className="font-mono text-[10px] text-t-faint group-hover:text-t-muted">{n.code}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-border-subtle p-4">
          <p className="mb-2 truncate font-mono text-xs text-t-muted" title={email}>
            {email}
          </p>
          <button className="t-btn t-btn--sm w-full" onClick={logout}>
            Logout
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6" key={location.pathname}>
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
    </div>
  )
}
