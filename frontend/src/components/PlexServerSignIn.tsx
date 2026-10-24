import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Button } from 'fluid-lycoris'
import { api, ApiError, type PlexLinkStart, type PlexServerConnect, type PlexServerPoll } from '../api'
import { useFailToast } from './toast'
import '../pages/settings/integrations.css'

/**
 * Connects the Plex server by signing in with plex.tv instead of pasting a URL
 * and a token: the official PIN flow, then the account's servers to pick
 * from. The backend keeps the address it reached the chosen server on and
 * that server's own token; onConnected hands the address to a form that
 * would otherwise save its old, empty one over it.
 */
export default function PlexServerSignIn({
  connected,
  onConnected,
}: {
  connected: boolean
  onConnected?: (res: PlexServerConnect) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const fail = useFailToast()
  const [pin, setPin] = useState<PlexLinkStart | null>(null)
  const [servers, setServers] = useState<PlexServerPoll['servers'] | null>(null)
  const [expired, setExpired] = useState(false)
  const [busy, setBusy] = useState('')
  const [done, setDone] = useState<PlexServerConnect | null>(null)
  const timer = useRef<ReturnType<typeof setInterval>>(undefined)

  // Which sign-in run is current. start() takes a number; a reset, a newer
  // start or the unmount moves it on, and whatever a run's requests answer
  // after that is dropped (an in-flight poll must not bring the list back).
  const run = useRef(0)
  useEffect(
    () => () => {
      run.current++
      clearInterval(timer.current)
    },
    [],
  )

  // back to the start buttons: the sign-in under way or the account's list is dropped
  const reset = () => {
    run.current++
    clearInterval(timer.current)
    setPin(null)
    setServers(null)
  }

  const start = async () => {
    const mine = ++run.current
    let p: PlexLinkStart
    try {
      p = await api.post<PlexLinkStart>('/api/plex/server/link/start')
    } catch (e) {
      return fail(e)
    }
    if (run.current !== mine) return
    setPin(p)
    setServers(null)
    setDone(null)
    setExpired(false)
    window.open(p.url, '_blank', 'noopener')
    clearInterval(timer.current)
    // the server forgets a sign-in after ten minutes and answers 404 from then on
    const until = Date.now() + 10 * 60_000
    const giveUp = () => {
      clearInterval(timer.current)
      setPin(null)
      setExpired(true)
    }
    timer.current = setInterval(async () => {
      if (Date.now() > until) return giveUp()
      try {
        const res = await api.get<PlexServerPoll>(`/api/plex/server/link/poll?id=${p.id}`)
        if (run.current !== mine) return
        if (res.linked) {
          clearInterval(timer.current)
          setServers(res.servers)
        }
      } catch (e) {
        // plex.tv unreachable for a moment: the next round asks again
        if (run.current === mine && e instanceof ApiError && e.status === 404) giveUp()
      }
    }, 2000)
  }

  const connect = async (server: string) => {
    if (!pin) return
    setBusy(server)
    try {
      const res = await api.post<PlexServerConnect>('/api/plex/server/connect', { id: String(pin.id), server })
      setDone(res)
      setPin(null)
      setServers(null)
      onConnected?.(res)
      for (const key of ['settings', 'plex-me', 'plex-sections']) qc.invalidateQueries({ queryKey: [key] })
    } catch (e) {
      fail(e)
    } finally {
      setBusy('')
    }
  }

  if (servers) {
    return (
      <div className="space-y-2">
        <p className="text-ctl-sm">{servers.length ? t('settings.plexPickServer') : t('settings.plexNoServers')}</p>
        <div className="sf-acts">
          <Button size="sm" disabled={!!busy} onClick={reset}>
            {t('settings.plexOtherAccount')}
          </Button>
          {servers.map((sv) => (
            <Button key={sv.id} size="sm" disabled={!!busy} onClick={() => connect(sv.id)}>
              {busy === sv.id ? t('settings.plexConnecting') : sv.name}
              {!sv.owned && <span className="text-t-muted"> · {t('settings.plexShared')}</span>}
            </Button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="sf-acts">
      {pin ? (
        <>
          <span>{t('settings.plexWatchlistPending', { code: pin.code })}</span>
          {/* a browser that blocked the popup (it opens after the request) leaves this */}
          <a href={pin.url} target="_blank" rel="noopener noreferrer" className="underline">
            {t('settings.plexOpenTab')}
          </a>
          <Button size="sm" onClick={reset}>
            {t('common.cancel')}
          </Button>
        </>
      ) : (
        <>
          <Button size="sm" onClick={start}>
            {connected ? t('settings.plexSignInOther') : t('settings.plexSignIn')}
          </Button>
          {done && (
            <span className="int-ok" role="status">
              <Trans
                i18nKey="settings.plexConnected"
                values={{ server: done.name, url: done.url }}
                components={{ b: <b /> }}
              />
            </span>
          )}
          {expired && <span role="status">{t('settings.plexWatchlistExpired')}</span>}
        </>
      )}
    </div>
  )
}
