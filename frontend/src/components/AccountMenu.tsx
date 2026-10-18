import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { BookOpen, ChevronUp, Info, LogOut, Paintbrush, Settings, UserRound } from 'lucide-react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
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
 * The sidebar foot's account button, a disclosure: the signed-in address is
 * the box's bottom row, and the entries grow out of it upward inside the same
 * surface. Plain buttons in a group folded by height rather than a menu, so
 * Tab walks them and the chevron says open or closed; Escape or a press
 * outside folds it again, Escape handing focus back to the button.
 */
export function AccountMenu({ email }: { email: string }) {
  const { t } = useTranslation()
  const { entries, update } = useAccountEntries()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  return (
    <div
      className="ws-acct-box"
      data-open={open}
      ref={box}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return
        e.stopPropagation()
        setOpen(false)
        button.current?.focus()
      }}
    >
      <div className="ws-acct-fold" id={id} role="group" aria-label={t('nav.accountMenu', { email })} inert={!open}>
        <div className="ws-acct-list">
          {entries.map((e) => (
            <Fragment key={e.key}>
              {e.key === 'logout' && <hr className="ws-acct-sep" />}
              <button
                type="button"
                className="ws-acct-item"
                onClick={() => {
                  setOpen(false)
                  e.onClick()
                }}
              >
                {e.icon}
                {e.label}
              </button>
            </Fragment>
          ))}
        </div>
      </div>
      <button
        ref={button}
        type="button"
        className="ws-acct"
        title={email}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <UpdateDot show={update}>
          <UserRound aria-hidden size="1.125rem" />
        </UpdateDot>
        <span className="ws-acct-t">{email}</span>
        <ChevronUp aria-hidden size="1rem" className="ws-acct-chev" />
      </button>
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
