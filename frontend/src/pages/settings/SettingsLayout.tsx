import type { ReactNode } from 'react'
import { Activity, ArrowDownUp, Bell, ChevronRight, LogOut, Mail, Plug, Server, Settings2, Shield, Upload, UserRound, Users } from 'lucide-react'
import { NavLink, Navigate, Outlet } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Badge, Button, navItemClass, Panel } from '@weebsync/design-system'
import { api } from '../../api'
import { useAuth } from '../../hooks'

const PERSONAL = [
  { to: 'general', key: 'settings.nav.general', icon: Settings2 },
  { to: 'account', key: 'settings.nav.account', icon: UserRound },
  { to: 'notifications', key: 'settings.nav.notifications', icon: Bell },
]
const SOURCES = [{ to: 'servers', key: 'nav.servers', icon: Server }]
const ADMIN = [
  { to: 'transfers', key: 'settings.nav.transfers', icon: ArrowDownUp },
  { to: 'security', key: 'settings.nav.security', icon: Shield },
  { to: 'integrations', key: 'settings.nav.integrations', icon: Plug },
  { to: 'email', key: 'settings.nav.email', icon: Mail },
  { to: 'users', key: 'settings.nav.users', icon: Users },
  { to: 'jobs', key: 'settings.nav.jobs', icon: Activity },
  { to: 'import', key: 'settings.nav.import', icon: Upload },
]

export function AdminRoute({ children }: { children: ReactNode }) {
  const { data: user } = useAuth()
  if (!user?.isAdmin) return <Navigate to="/settings" replace />
  return <>{children}</>
}

function useGroups() {
  const { data: user } = useAuth()
  return [
    { label: 'settings.groupPersonal', items: PERSONAL },
    { label: 'settings.groupSources', items: SOURCES },
    ...(user?.isAdmin ? [{ label: 'settings.groupAdmin', items: ADMIN }] : []),
  ]
}

// The hub at /settings: one row per section with a hint, and the account row
// with Logout. On a phone it is the screen behind the More sheet's Settings
// entry; on desktop it fills the content pane next to the side menu.
export function SettingsHub() {
  const { t } = useTranslation()
  const { data: user } = useAuth()
  const groups = useGroups()
  const logout = async () => {
    try {
      await api.post('/api/auth/logout')
    } catch {
      /* drop to the login screen either way */
    }
    window.location.href = '/'
  }
  return (
    <div className="flex flex-col gap-6">
      <Panel className="flex items-center justify-between gap-3 p-3">
        <span className="min-w-0 truncate font-mono text-xs text-t-muted" title={user?.email}>
          {user?.email}
        </span>
        <Button size="sm" onClick={logout}>
          <LogOut aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('app.logout')}
        </Button>
      </Panel>
      {groups.map((g) => (
        <nav key={g.label} aria-label={t(g.label)}>
          <Badge className="mb-2">{t(g.label)}</Badge>
          <div className="border-t border-border-subtle lg:grid lg:grid-cols-2 lg:gap-x-6">
            {g.items.map((i) => (
              <NavLink key={i.to} to={i.to} className={({ isActive }) => navItemClass('row', isActive)}>
                <i.icon aria-hidden size="1.25em" className="shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col py-2">
                  <span>{t(i.key)}</span>
                  {t(`settings.hub.${i.to}`, { defaultValue: '' }) && (
                    <span className="font-sans text-xs text-t-muted">{t(`settings.hub.${i.to}`)}</span>
                  )}
                </span>
                <ChevronRight aria-hidden size="1em" className="shrink-0 text-t-faint" />
              </NavLink>
            ))}
          </div>
        </nav>
      ))}
    </div>
  )
}

export default function SettingsLayout() {
  const { t } = useTranslation()
  const groups = useGroups()
  return (
    <div>
      {/* the desktop's heading; on a phone the app bar carries the section
          title and a back link to the hub */}
      <header className="mb-6 hidden lg:block">
        <h2 className="font-display text-xl font-semibold tracking-wider">{t('settings.title')}</h2>
        <Badge className="mt-1">{t('settings.sub')}</Badge>
      </header>

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* desktop: grouped side menu. w-52 like the app's own sidebar: at
            w-44 the entry "Benachrichtigungen" needed 9px more than it had */}
        <nav aria-label={t('settings.navLabel')} className="hidden shrink-0 lg:block lg:w-52">
          <div className="flex flex-col gap-5">
            {groups.map((g) => (
              <div key={g.label}>
                <Badge className="mb-1">{t(g.label)}</Badge>
                <ul className="flex flex-col gap-1">
                  {g.items.map((i) => (
                    <li key={i.to}>
                      <NavLink to={i.to} className={({ isActive }) => navItemClass('sidebar', isActive)}>
                        <i.icon aria-hidden size="1.25em" className="shrink-0" />
                        {t(i.key)}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        <div className="min-w-0 max-w-4xl flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
