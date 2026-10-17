import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { PALETTE_SEARCH_EVENT, parseShare } from '../share'
import Loading from '../components/Loading'

/**
 * The target of the installed app's share sheet entry: reads what was shared
 * and moves on at once (replacing this entry, so back does not return here).
 */
export default function Share() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const raw = params.toString()
  useEffect(() => {
    const target = parseShare(new URLSearchParams(raw))
    if (target.kind === 'title') {
      navigate(target.path, { replace: true })
      return
    }
    navigate('/', { replace: true })
    if (target.kind === 'search') {
      // after the dashboard has taken the place: the palette stands over it
      const q = target.q
      setTimeout(() => window.dispatchEvent(new CustomEvent(PALETTE_SEARCH_EVENT, { detail: q })), 0)
    }
  }, [raw, navigate])
  return <Loading />
}
