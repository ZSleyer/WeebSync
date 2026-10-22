import { useId, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Button, Dialog, Segmented } from 'fluid-lycoris'
import { api, ApiError, type ServerInfo } from '../api'
import type { Schemas } from '../api.gen'

type Fail = Schemas['api.MigrateFTPSError']

const IMPLICIT = 990
const EXPLICIT = 21

/** The cause the backend named for a failed FTPS test, else null. */
function failOf(e: unknown): Fail | null {
  if (!(e instanceof ApiError) || e.status !== 502) return null
  const d = e.data as Partial<Fail> | undefined
  return d?.code ? ({ error: e.message, code: d.code } as Fail) : null
}

/**
 * Moves a server that still has the retired plain FTP to FTPS: one choice
 * (explicit or implicit TLS), then the backend tries the connection with the
 * stored password and only saves the switch when it works. A failure says
 * why in words and offers to save anyway, to cancel, or to go to the
 * server's settings.
 */
export default function FtpsMigrateDialog({ server, onClose }: { server: ServerInfo; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const titleId = useId()
  // the stored port decides: 990 was implicit TLS' port, every other one speaks explicit
  const [mode, setMode] = useState<'explicit' | 'implicit'>(server.port === IMPLICIT ? 'implicit' : 'explicit')
  const [phase, setPhase] = useState<'ask' | 'testing' | 'failed' | 'done'>('ask')
  const [fail, setFail] = useState<{ code: string; text: string } | null>(null)
  const port = mode === 'implicit' ? IMPLICIT : server.port === IMPLICIT ? EXPLICIT : server.port

  const run = async (force: boolean) => {
    setPhase('testing')
    try {
      await api.post(`/api/servers/${server.id}/migrate-ftps`, { port, force })
      qc.invalidateQueries({ queryKey: ['servers'] })
      setPhase('done')
    } catch (e) {
      const f = failOf(e)
      setFail({ code: f?.code ?? 'connect_failed', text: e instanceof Error ? e.message : t('app.error') })
      setPhase('failed')
    }
  }

  const cause = fail
    ? fail.code === 'auth_failed'
      ? t('servers.migrate.errAuth')
      : fail.code === 'cert_untrusted'
        ? t('servers.migrate.errCert')
        : fail.code === 'tls_unsupported'
          ? t('servers.migrate.errTls')
          : fail.text
    : ''

  return (
    <Dialog onClose={onClose} width="max-w-lg" aria-labelledby={titleId}>
      <div className="dialog-body form-dlg">
        <h2 id={titleId} className="form-dlg-h">
          {t('servers.migrate.title', { name: server.name })}
        </h2>
        <div className="form-dlg-bd grid gap-3 overflow-y-auto">
          {phase === 'done' ? (
            <p role="status">{t('servers.migrate.done', { port })}</p>
          ) : (
            <>
              <p className="sf-note !mt-0">{t('servers.migrate.intro', { host: server.host })}</p>
              <Segmented
                aria-label={t('servers.migrate.mode')}
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'explicit', label: t('servers.migrate.explicit') },
                  { value: 'implicit', label: t('servers.migrate.implicit') },
                ]}
              />
              <p className="sf-note !mt-0">{t('servers.migrate.modeHint', { port })}</p>
            </>
          )}
          <div aria-live="polite">
            {phase === 'testing' && <p>{t('servers.migrate.testing')}</p>}
            {phase === 'failed' && (
              <div role="alert" className="grid gap-2">
                <p className="sf-issue">{cause}</p>
                {fail?.code !== 'auth_failed' && fail?.code !== 'connect_failed' && (
                  <p className="sf-note !mt-0">{t('servers.migrate.trySftp')}</p>
                )}
                {fail && cause !== fail.text && (
                  <p className="font-mono text-xs wrap-anywhere text-t-muted">{fail.text}</p>
                )}
              </div>
            )}
          </div>
        </div>
        <footer className="dlg-foot ftps-foot">
          {phase === 'done' && (
            <Button variant="primary" onClick={onClose}>
              {t('common.close')}
            </Button>
          )}
          {(phase === 'ask' || phase === 'testing') && (
            <>
              <Button onClick={onClose}>{t('common.cancel')}</Button>
              <Button variant="primary" disabled={phase === 'testing'} onClick={() => run(false)}>
                {t('servers.migrate.go')}
              </Button>
            </>
          )}
          {phase === 'failed' && (
            <>
              <Button onClick={onClose}>{t('common.cancel')}</Button>
              <Button
                onClick={() => {
                  onClose()
                  navigate('/settings/servers')
                }}
              >
                {t('servers.migrate.settings')}
              </Button>
              <Button onClick={() => run(true)}>{t('servers.migrate.saveAnyway')}</Button>
              <Button variant="primary" onClick={() => run(false)}>
                {t('servers.migrate.retry')}
              </Button>
            </>
          )}
        </footer>
      </div>
    </Dialog>
  )
}
