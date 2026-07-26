import { useEffect, type ReactNode } from 'react'
import { Activity, ArrowDownUp, Bell, Info, Mail, Palette, Plug, Shield, Upload, UserRound, Users } from 'lucide-react'
import { NavLink, Navigate, Outlet, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Badge, buttonClass, navItemClass } from '@weebsync/design-system'
import { useAuth } from '../../hooks'

const PERSONAL = [
  { to: 'look', key: 'settings.nav.look', icon: Palette },
  { to: 'account', key: 'settings.nav.account', icon: UserRound },
  { to: 'notifications', key: 'settings.nav.notifications', icon: Bell },
  { to: 'about', key: 'settings.nav.about', icon: Info },
]
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
    if (current) document.title = `${t(current.key)} - ${t('settings.title')} - WeebSync`
  }, [current, t])

  return (
    <div>
      <header className="mb-6">
        <h2 className="font-display text-xl font-semibold tracking-wider">{t('settings.title')}</h2>
        <Badge className="mt-1">{t('settings.sub')}</Badge>
      </header>

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* phone: chip tabs - every section visible at once, one tap. A grid,
            not a wrapping row: the labels differ enough in length that free
            wrapping left a ragged block with single entries stranded on their
            own line. The column count follows the longest label
            ("Benachrichtigungen"): two up to md, because the coarse-pointer
            root font grows with the viewport and eats the room a third column
            would need - at 640px it already clips. */}
        <nav aria-label={t('settings.navLabel')} className="flex flex-col gap-3 lg:hidden">
          {groups.map((g) => (
            <div key={g.label}>
              <Badge className="mb-1.5">{t(g.label)}</Badge>
              <div className="grid grid-cols-2 gap-1.5 md:grid-cols-3">
                {g.items.map((i) => (
                  <NavLink
                    key={i.to}
                    to={i.to}
                    className={({ isActive }) =>
                      `${buttonClass({ size: 'sm', variant: isActive ? 'primary' : 'default' })} min-w-0!`
                    }
                  >
                    <i.icon aria-hidden size="1em" className="mr-1 inline shrink-0 align-[-0.125em]" />
                    <span className="truncate">{t(i.key)}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
        {/* desktop: grouped side menu */}
        {/* w-52 like the app's own sidebar: at w-44 the entry "Benachrichtigungen"
            needed 9px more than it had, and a nowrap entry has nothing to clip
            it - the label ran into the border */}
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
