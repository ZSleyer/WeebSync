import { Fragment, useState, type ReactNode } from 'react'
import { BookOpen, ChevronUp, Info, LogOut, Paintbrush, Settings, UserRound } from 'lucide-react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Menu, MenuItem, useMenu } from 'fluid-lycoris'
import { logout, useUpdateHint } from '../hooks'
import ActionSheet, { type SheetAction } from './ActionSheet'

/** A small dot on an icon's corner: a newer build is out. */
export function UpdateDot({ show, children }: { show: boolean; children: ReactNode }) {
  const { t } = useTranslation()
  if (!show) return <>{children}</>
  return (
    <span className="ws-dot">
      {children}
      <i aria-hidden />
      <span className="sr-only">{t('app.updateHint')}</span>
    </span>
  )
}

interface Entry {
  key: string
  label: string
  icon: ReactNode
  onClick: () => void
}

/**
 * What the account menu holds, one list for the sidebar's menu and the
 * phone's sheet: settings and the three places in it people look for most,
 * then the way out. The About entry carries the update dot.
 */
export function useAccountEntries(): { entries: Entry[]; update: boolean } {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const update = !!useUpdateHint()
  const icon = (I: typeof Settings, dot = false) => (
    <UpdateDot show={dot}>
      <I aria-hidden size="1.125rem" />
    </UpdateDot>
  )
  const go = (to: string) => () => navigate(to)
  const entries: Entry[] = [
    { key: 'settings', label: t('nav.settings'), icon: icon(Settings), onClick: go('/settings') },
    { key: 'account', label: t('settings.nav.account'), icon: icon(UserRound), onClick: go('/settings/account') },
    { key: 'general', label: t('nav.appearance'), icon: icon(Paintbrush), onClick: go('/settings/general') },
    { key: 'rules', label: t('settings.nav.rules'), icon: icon(BookOpen), onClick: go('/rules') },
    { key: 'about', label: t('settings.nav.about'), icon: icon(Info, update), onClick: go('/settings/about') },
    { key: 'logout', label: t('app.logout'), icon: icon(LogOut), onClick: () => void logout() },
  ]
  return { entries, update }
}

/**
 * The sidebar foot's account button: the signed-in address, and a menu above
 * it with settings, the account, the look, the rules and the way out. The
 * address heads the menu as plain text and names it.
 */
export function AccountMenu({ email }: { email: string }) {
  const { t } = useTranslation()
  const { entries, update } = useAccountEntries()
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
  return (
    <div className="relative" ref={ref} style={anchorStyle}>
      <button
        type="button"
        className="ws-acct"
        title={email}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <UpdateDot show={update}>
          <UserRound aria-hidden size="1.125rem" />
        </UpdateDot>
        <span className="ws-acct-t">{email}</span>
        <ChevronUp aria-hidden size="1rem" className="ws-acct-chev" />
      </button>
      {open && (
        <Menu kind="menu" anchor={anchor} placement="top-start" aria-label={t('nav.accountMenu', { email })}>
          <li aria-hidden className="ws-acct-head">
            {email}
          </li>
          {entries.map((e) => (
            <Fragment key={e.key}>
              {e.key === 'logout' && <li role="separator" className="my-1 h-px bg-border-subtle" />}
              <MenuItem
                onClick={() => {
                  setOpen(false)
                  e.onClick()
                }}
              >
                <span className="flex items-center gap-2.5">
                  {e.icon}
                  {e.label}
                </span>
              </MenuItem>
            </Fragment>
          ))}
        </Menu>
      )}
    </div>
  )
}

/**
 * The phone's account button in the app bar, the same person mark as the
 * sidebar's: the same entries as a bottom sheet instead of a link to the
 * settings hub (which is its first entry).
 */
export function AccountSheetButton({ email }: { email: string }) {
  const { t } = useTranslation()
  const { entries, update } = useAccountEntries()
  const [open, setOpen] = useState(false)
  const actions: SheetAction[] = entries.map((e) => ({ key: e.key, label: e.label, icon: e.icon, onClick: e.onClick }))
  return (
    <>
      <button
        type="button"
        className="ws-iconbtn"
        aria-label={t('nav.accountMenu', { email })}
        title={email}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <UpdateDot show={update}>
          <UserRound aria-hidden />
        </UpdateDot>
      </button>
      {open && <ActionSheet title={email} actions={actions} onClose={() => setOpen(false)} />}
    </>
  )
}
