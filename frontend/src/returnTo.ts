import { useEffect } from 'react'
import { useNavigate } from 'react-router'

// Where a visitor was headed when the sign-in sent them away. The password and
// passkey forms sign in on the same address, so nothing is lost there; the
// single sign-on round trip ends on "/", and the address (the installed app's
// share target carries its payload in it) would be gone. It is kept for the
// round trip in sessionStorage - this tab only, a few minutes at most.
const KEY = 'weebsync.returnTo'
const LIFE_MS = 15 * 60_000

/** Notes the current address, unless it is the start page, before leaving for the provider. */
export function rememberReturn() {
  const { pathname, search, hash } = window.location
  if (pathname === '/' || !pathname.startsWith('/') || pathname.startsWith('//') || pathname.startsWith('/api/')) return
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ to: pathname + search + hash, at: Date.now() }))
  } catch {
    // storage off: the round trip lands on the start page, as it always did
  }
}

/** The noted address, once; null when there is none or it went stale. */
export function takeReturn(): string | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    const v = raw ? (JSON.parse(raw) as { to?: unknown; at?: unknown }) : null
    if (typeof v?.to !== 'string' || typeof v.at !== 'number' || Date.now() - v.at > LIFE_MS) return null
    // an address of this app only
    return v.to.startsWith('/') && !v.to.startsWith('//') ? v.to : null
  } catch {
    return null
  }
}

/** Once signed in on the start page, goes where the sign-in interrupted. */
export function useRestoreReturn(signedIn: boolean) {
  const navigate = useNavigate()
  useEffect(() => {
    if (!signedIn || window.location.pathname !== '/') return
    const to = takeReturn()
    if (to) navigate(to, { replace: true })
  }, [signedIn, navigate])
}
