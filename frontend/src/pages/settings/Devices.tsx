import { useId, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, Input, Row, RowAction, Rows, SettingsField } from 'fluid-lycoris'
import { api, type DeviceInfo } from '../../api'
import { useConfirm } from '../../components/confirm'
import { relTime } from '../../components/threadText'
import { SettingsPanel } from './ui'

// The code alphabet the server draws from (RFC 8628, section 6.1): 20
// consonants, no digits, case-insensitive.
const CODE_CHARS = 'BCDFGHJKLMNPQRSTVWXZ'

/**
 * A typed device code as the server reads it: upper case, everything outside
 * the alphabet dropped, shown as XXXX-XXXX once it has more than four symbols.
 */
export function formatDeviceCode(input: string): string {
  const sym = [...input.toUpperCase()]
    .filter((c) => CODE_CHARS.includes(c))
    .slice(0, 8)
    .join('')
  return sym.length > 4 ? `${sym.slice(0, 4)}-${sym.slice(4)}` : sym
}

// Paired devices (a TV launcher): link one by the code it shows, see when
// each was last used, revoke one. There is no list of devices waiting for a
// code - only the code on your own screen links a device.
export function DevicesSection() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const id = useId()
  const [now] = useState(() => Date.now())
  const { data: devices } = useQuery<DeviceInfo[]>({ queryKey: ['devices'], queryFn: () => api.get('/api/devices') })
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [linked, setLinked] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setLinked('')
    if (code.replace('-', '').length !== 8) return setError(t('devices.codeIncomplete'))
    setBusy(true)
    setError('')
    try {
      const res = await api.post<{ name: string }>('/api/devices/approve', { userCode: code })
      setCode('')
      setLinked(t('devices.linked', { name: res.name }))
      qc.invalidateQueries({ queryKey: ['devices'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (d: DeviceInfo) => {
    const ok = await confirm({
      title: t('devices.revokeTitle'),
      message: t('devices.revokeHint', { name: d.name }),
      confirmLabel: t('devices.revoke'),
      destructive: true,
    })
    if (!ok) return
    setError('')
    try {
      await api.del(`/api/devices/${d.id}`)
      qc.invalidateQueries({ queryKey: ['devices'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    }
  }

  return (
    <SettingsPanel id="devices" title={t('devices.title')} desc={t('devices.hint')}>
      <form onSubmit={submit} noValidate>
        <SettingsField label={t('devices.code')} hint={t('devices.codeHint')} hintId={id + 'h'} htmlFor={id + 'c'}>
          <Input
            id={id + 'c'}
            value={code}
            onChange={(e) => setCode(formatDeviceCode(e.target.value))}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            placeholder="BCDF-GHJK"
            maxLength={9}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}h ${id}e` : id + 'h'}
          />
        </SettingsField>
        <div className="sf-acts">
          <Button type="submit" size="sm" variant="primary" disabled={busy}>
            {t('devices.link')}
          </Button>
        </div>
        <p role="status" className="t-sf-h mt-2 text-ok empty:hidden">
          {linked}
        </p>
        {error && (
          <p id={id + 'e'} className="sf-issue mt-2" role="alert">
            {error}
          </p>
        )}
      </form>
      {devices && devices.length === 0 && <p className="sf-note">{t('devices.none')}</p>}
      {devices && devices.length > 0 && (
        <Rows aria-label={t('devices.listLabel')}>
          {devices.map((d) => (
            <Row
              key={d.id}
              title={<span className="min-w-0 truncate">{d.name}</span>}
              sub={[
                d.lastUsedAt
                  ? t('devices.lastUsed', { when: relTime(Date.parse(d.lastUsedAt) / 1000, now, i18n.language) })
                  : t('devices.neverUsed'),
                d.lastIp,
                t('devices.since', { when: new Date(d.createdAt).toLocaleDateString(i18n.language) }),
              ]
                .filter(Boolean)
                .join(' · ')}
              trailing={
                <RowAction aria-label={`${t('devices.revoke')}: ${d.name}`} onClick={() => void revoke(d)}>
                  {t('devices.revoke')}
                </RowAction>
              }
            />
          ))}
        </Rows>
      )}
    </SettingsPanel>
  )
}
