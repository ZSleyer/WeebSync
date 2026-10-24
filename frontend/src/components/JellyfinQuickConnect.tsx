import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { Button } from 'fluid-lycoris'
import { api, ApiError, type JellyfinLinkStart, type JellyfinPoll } from '../api'
import { useFailToast } from './toast'
import '../pages/settings/integrations.css'

/**
 * Signs in to Jellyfin with Quick Connect, its counterpart to the plex.tv PIN:
 * WeebSync shows a code, the user enters it in a Jellyfin app they are signed
 * in to (Settings, Quick Connect), and the backend trades it for a token. The
 * same flow connects the server (admin, `server` set to its address) and links
 * a user's own account for their favourites.
 */
export default function JellyfinQuickConnect({
  server,
  label,
  disabled,
  onDone,
}: {
  /** the server address to connect; omitted links the user's account */
  server?: string
  label: string
  disabled?: boolean
  onDone?: (user: string) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const fail = useFailToast()
  const base = server === undefined ? '/api/jellyfin/link' : '/api/jellyfin/server/link'
  const [code, setCode] = useState('')
  const [expired, setExpired] = useState(false)
  const [done, setDone] = useState('')
  const timer = useRef<ReturnType<typeof setInterval>>(undefined)

  // false once unmounted: a request still in flight must not start polling
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearInterval(timer.current)
    }
  }, [])

  const stop = () => {
    clearInterval(timer.current)
    setCode('')
  }

  const start = async () => {
    let s: JellyfinLinkStart
    try {
      s = await api.post<JellyfinLinkStart>(`${base}/start`, server === undefined ? undefined : { url: server })
    } catch (e) {
      return fail(e)
    }
    if (!alive.current) return
    setCode(s.code)
    setDone('')
    setExpired(false)
    clearInterval(timer.current)
    // Jellyfin forgets a Quick Connect request after ten minutes
    const until = Date.now() + 10 * 60_000
    timer.current = setInterval(async () => {
      if (Date.now() > until) {
        stop()
        return setExpired(true)
      }
      try {
        const res = await api.get<JellyfinPoll>(`${base}/poll?id=${encodeURIComponent(s.id)}`)
        if (!res.linked) return
        stop()
        setDone(res.user ?? '')
        onDone?.(res.user ?? '')
        for (const key of ['settings', 'plex-me', 'plex-sections', 'plex-account'])
          qc.invalidateQueries({ queryKey: [key] })
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          stop()
          setExpired(true)
        } else if (e instanceof ApiError && e.status === 403) {
          stop() // signed in, but not as an administrator: asking again changes nothing
          fail(e)
        }
        // anything else: Jellyfin unreachable for a moment, the next round asks again
      }
    }, 2000)
  }

  return (
    <div className="sf-acts">
      {code ? (
        <span role="status">
          <Trans i18nKey="settings.jellyfinCode" values={{ code }} components={{ b: <b className="font-mono" /> }} />
        </span>
      ) : (
        <>
          <Button size="sm" onClick={start} disabled={disabled}>
            {label}
          </Button>
          {done && (
            <span className="int-ok" role="status">
              {t('settings.jellyfinSignedIn', { user: done })}
            </span>
          )}
          {expired && <span role="status">{t('settings.plexWatchlistExpired')}</span>}
        </>
      )}
    </div>
  )
}
