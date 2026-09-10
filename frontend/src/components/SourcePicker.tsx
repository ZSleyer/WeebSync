import { ChevronDown, HardDrive, Plus, Server } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Menu, MenuItem, useMenu } from '@weebsync/design-system'
import type { ServerInfo } from '../api'
import { ServerIcon } from './serverIcon'

export type Source = 'local' | number

// SourcePicker is the one control for "which library am I looking at": the
// local disk, one of the servers, and the way to add another. It replaced a
// pressed-button group plus a separate select plus an add-server icon - three
// controls for one question, and the group wrapped into two rows as soon as a
// third server existed.
export default function SourcePicker({
  value,
  servers,
  onChange,
  className,
}: {
  value: Source
  servers: ServerInfo[]
  onChange: (s: Source) => void
  className?: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { open, setOpen, ref } = useMenu()
  const current = typeof value === 'number' ? servers.find((s) => s.id === value) : undefined
  const label = value === 'local' ? t('files.local') : (current?.name ?? t('remote.source'))
  // a server draws its own picture when it picked one, the plain server
  // otherwise; the local library always draws the drive
  const mark = (s: ServerInfo | undefined, local: boolean) =>
    local ? <HardDrive aria-hidden size="1em" className="shrink-0" /> : s?.icon ? <ServerIcon name={s.icon} aria-hidden size="1em" className="shrink-0" /> : <Server aria-hidden size="1em" className="shrink-0" />

  const pick = (s: Source) => {
    onChange(s)
    setOpen(false)
  }

  return (
    <div className={`relative min-w-0 ${className ?? ''}`} ref={ref}>
      <button
        type="button"
        className="flex min-h-8 max-w-full items-center gap-1.5 rounded-full border border-border-input px-3 text-sm text-t-primary hover:border-accent/60"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('remote.source')}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        {mark(current, value === 'local')}
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden size="0.9em" className="shrink-0 text-t-muted" />
      </button>
      {open && (
        <Menu className="t-pop--up absolute top-full left-0 z-20 mt-1 w-max max-w-[70vw]" aria-label={t('remote.source')}>
          <MenuItem selected={value === 'local'} onClick={() => pick('local')}>
            <span className="flex items-center gap-2">
              {mark(undefined, true)}
              {t('files.local')}
            </span>
          </MenuItem>
          {servers.map((s) => (
            <MenuItem key={s.id} selected={value === s.id} onClick={() => pick(s.id)}>
              <span className="flex items-center gap-2">
                {mark(s, false)}
                <span className="truncate">{s.name}</span>
              </span>
            </MenuItem>
          ))}
          <li role="separator" className="my-1 border-t border-border-subtle" />
          <MenuItem
            onClick={() => {
              setOpen(false)
              navigate('/settings/servers')
            }}
          >
            <span className="flex items-center gap-2 text-t-secondary">
              <Plus aria-hidden size="1em" className="shrink-0" />
              {t('files.manageSources')}
            </span>
          </MenuItem>
        </Menu>
      )}
    </div>
  )
}
