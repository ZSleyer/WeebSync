import { useEffect, type ReactNode } from 'react'
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../hooks'

const PERSONAL = [
  { to: 'look', key: 'settings.nav.look' },
  { to: 'notifications', key: 'settings.nav.notifications' },
]
const ADMIN = [
  { to: 'transfers', key: 'settings.nav.transfers' },
  { to: 'security', key: 'settings.nav.security' },
  { to: 'integrations', key: 'settings.nav.integrations' },
  { to: 'email', key: 'settings.nav.email' },
  { to: 'users', key: 'settings.nav.users' },
]

export function AdminRoute({ children }: { children: ReactNode }) {
  const { data: user } = useAuth()
  if (!user?.isAdmin) return <Navigate to="/settings/look" replace />
  return <>{children}</>
}

export default function SettingsLayout() {
  const { t } = useTranslation()
  const { data: user } = useAuth()
  const location = useLocation()
  const isAdmin = !!user?.isAdmin

  const groups = [
    { label: 'settings.groupPersonal', items: PERSONAL },
    ...(isAdmin ? [{ label: 'settings.groupAdmin', items: ADMIN }] : []),
  ]

  const current = groups.flatMap((g) => g.items).find((i) => location.pathname === `/settings/${i.to}`)
  useEffect(() => {
    if (current) document.title = `${t(current.key)} — ${t('settings.title')} — WeebSync`
  }, [current, t])

  return (
    <div className="max-w-5xl">
      <header className="mb-6">
        <h2 className="font-display text-xl font-semibold tracking-wider">{t('settings.title')}</h2>
        <span className="t-label mt-1">{t('settings.sub')}</span>
      </header>

      <div className="flex flex-col gap-6 lg:flex-row">
        <nav aria-label={t('settings.navLabel')} className="shrink-0 lg:w-44">
          <div className="flex gap-4 overflow-x-auto lg:flex-col lg:gap-5 lg:overflow-visible">
            {groups.map((g) => (
              <div key={g.label} className="shrink-0 lg:shrink">
                <span className="t-label mb-1">{t(g.label)}</span>
                <ul className="flex gap-1 lg:flex-col">
                  {g.items.map((i) => (
                    <li key={i.to} className="shrink-0">
                      <NavLink
                        to={i.to}
                        className={({ isActive }) =>
                          `flex min-h-12 items-center whitespace-nowrap border-b-2 px-3 font-display text-sm transition-colors lg:min-h-0 lg:border-b-0 lg:border-l-2 lg:px-4 lg:py-2 ${
                            isActive
                              ? 'border-accent bg-bg-hover text-accent'
                              : 'border-transparent text-t-muted hover:bg-bg-hover hover:text-t-primary'
                          }`
                        }
                      >
                        {t(i.key)}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        <div className="min-w-0 max-w-2xl flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
