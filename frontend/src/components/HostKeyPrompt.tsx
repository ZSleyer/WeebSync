import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@weebsync/design-system'
import { api, type KeyConflict } from '../api'

// HostKeyPrompt is the review a server's SSH host key gets before it is
// trusted: the fingerprints, and accept or reject. It sits wherever a dial ran
// into the key - the connection test, the file listing, the catalog - so the
// user is not sent to the settings to find the one button that asks.
export default function HostKeyPrompt({
  serverId,
  conflict,
  onAccepted,
  onRejected,
  className,
}: {
  serverId: number
  conflict: KeyConflict
  /** the key is pinned; the caller retries what failed */
  onAccepted: () => void
  onRejected: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const [error, setError] = useState('')
  const accept = async () => {
    setError('')
    try {
      await api.post(`/api/servers/${serverId}/trust-hostkey`, { key: conflict.newKey })
      onAccepted()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('app.error'))
    }
  }
  return (
    <div className={['rounded-lg border border-err/40 p-3 text-xs', className].filter(Boolean).join(' ')} role="alert">
      <p className="mb-2 text-t-muted">{t(conflict.code === 'host_key_unknown' ? 'servers.hostKeyUnknown' : 'servers.hostKeyChanged')}</p>
      {conflict.oldFingerprint && (
        <p className="break-all font-mono">
          <span className="text-t-muted">{t('servers.hostKeyOld')}: </span>
          {conflict.oldFingerprint}
        </p>
      )}
      <p className="mb-2 break-all font-mono">
        <span className="text-t-muted">{t('servers.hostKeyNew')}: </span>
        {conflict.newFingerprint}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="danger" onClick={accept}>
          <ShieldCheck aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('servers.hostKeyAccept')}
        </Button>
        <Button size="sm" onClick={onRejected}>
          {t('servers.hostKeyReject')}
        </Button>
      </div>
      {error && <p className="mt-2 text-err">{error}</p>}
    </div>
  )
}
