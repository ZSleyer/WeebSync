import { useEffect, type ReactNode } from 'react'
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../hooks'

const PERSONAL = [
  { to: 'look', key: 'settings.nav.look' },
  { to: 'account', key: 'settings.nav.account' },
  { to: 'notifications', key: 'settings.nav.notifications' },
  { to: 'about', key: 'settings.nav.about' },
]
const ADMIN = [
  { to: 'transfers', key: 'settings.nav.transfers' },
  { to: 'security', key: 'settings.nav.security' },
  { to: 'integrations', key: 'settings.nav.integrations' },
  { to: 'email', key: 'settings.nav.email' },
  { to: 'users', key: 'settings.nav.users' },
  { to: 'jobs', key: 'settings.nav.jobs' },
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
        {/* phone: wrapping chip tabs — every section visible at once, one tap */}
        <nav aria-label={t('settings.navLabel')} className="flex flex-col gap-3 lg:hidden">
          {groups.map((g) => (
            <div key={g.label}>
              <span className="t-label mb-1.5">{t(g.label)}</span>
              <div className="flex flex-wrap gap-1.5">
                {g.items.map((i) => (
                  <NavLink
                    key={i.to}
                    to={i.to}
                    className={({ isActive }) => `t-btn t-btn--sm ${isActive ? 't-btn--primary' : ''}`}
                  >
                    {t(i.key)}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
        {/* desktop: grouped side menu */}
        <nav aria-label={t('settings.navLabel')} className="hidden shrink-0 lg:block lg:w-44">
          <div className="flex flex-col gap-5">
            {groups.map((g) => (
              <div key={g.label}>
                <span className="t-label mb-1">{t(g.label)}</span>
                <ul className="flex flex-col gap-1">
                  {g.items.map((i) => (
                    <li key={i.to}>
                      <NavLink
                        to={i.to}
                        className={({ isActive }) =>
                          `flex items-center whitespace-nowrap border-l-2 px-4 py-2 font-display text-sm transition-colors ${
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
