import type { ReactNode } from 'react'
import { Activity, ArrowDownUp, Bell, Database, Link2, LogOut, Plug, RefreshCw, Server, Settings2, Shield, UserRound } from 'lucide-react'
import { Navigate, Outlet } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Panel, useMediaQuery } from '@weebsync/design-system'
import { api } from '../../api'
import { useAuth, useUpdateHint } from '../../hooks'
import { WIDE_MQ } from '../../components/PageActions'
import { SectionHub, SectionNav, type SectionGroup } from '../../components/SectionNav'

const PERSONAL = [
  { to: 'general', key: 'settings.nav.general', icon: Settings2, hint: 'settings.hub.general' },
  { to: 'account', key: 'settings.nav.account', icon: UserRound, hint: 'settings.hub.account' },
  { to: 'sync', key: 'settings.nav.sync', icon: RefreshCw, hint: 'settings.hub.sync' },
  { to: 'notifications', key: 'settings.nav.notifications', icon: Bell, hint: 'settings.hub.notifications' },
]
const SOURCES = [{ to: 'servers', key: 'nav.servers', icon: Server, hint: 'settings.hub.servers' }]
const ADMIN = [
  { to: 'transfers', key: 'settings.nav.transfers', icon: ArrowDownUp, hint: 'settings.hub.transfers' },
  { to: 'security', key: 'settings.nav.security', icon: Shield, hint: 'settings.hub.security' },
  { to: 'integrations', key: 'settings.nav.integrations', icon: Plug, hint: 'settings.hub.integrations' },
]
const MAINTENANCE = [
  { to: 'jobs', key: 'settings.nav.jobs', icon: Activity, hint: 'settings.hub.jobs' },
  { to: 'matching', key: 'settings.nav.matching', icon: Link2, hint: 'settings.hub.matching' },
  { to: 'data', key: 'settings.nav.data', icon: Database, hint: 'settings.hub.data' },
]

export function AdminRoute({ children }: { children: ReactNode }) {
  const { data: user } = useAuth()
  if (!user?.isAdmin) return <Navigate to="/settings" replace />
  return <>{children}</>
}

function useGroups(): SectionGroup[] {
  const { data: user } = useAuth()
  // the About panel lives on General: a newer build out marks that entry
  const update = useUpdateHint()
  return [
    { label: 'settings.groupPersonal', items: PERSONAL.map((i) => (i.to === 'general' ? { ...i, alert: !!update } : i)) },
    { label: 'settings.groupSources', items: SOURCES },
    ...(user?.isAdmin ? [{ label: 'settings.groupAdmin', items: ADMIN }, { label: 'settings.groupMaintenance', items: MAINTENANCE }] : []),
  ]
}

// The hub at /settings: one row per section with a hint, and the account row
// with Logout. On a phone it is the screen behind the More sheet's Settings
// entry. Desktop has the side menu with the same sections, so there the
// index opens the first section instead of listing the menu a second time.
export function SettingsHub() {
  const { t } = useTranslation()
  const { data: user } = useAuth()
  const groups = useGroups()
  const wide = useMediaQuery(WIDE_MQ)
  if (wide) return <Navigate to="/settings/general" replace />
  const logout = async () => {
    try {
      await api.post('/api/auth/logout')
    } catch {
      /* drop to the login screen either way */
    }
    window.location.href = '/'
  }
  return (
    <SectionHub
      groups={groups}
      before={
        <Panel className="flex items-center justify-between gap-3 p-3">
          <span className="min-w-0 truncate font-mono text-xs text-t-muted" title={user?.email}>
            {user?.email}
          </span>
          <Button size="sm" onClick={logout}>
            <LogOut aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('app.logout')}
          </Button>
        </Panel>
      }
    />
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
        <SectionNav label={t('settings.navLabel')} groups={groups} />

        <div className="min-w-0 max-w-4xl flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
