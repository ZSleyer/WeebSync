import { Navigate, useLocation } from 'react-router'

/**
 * A permanent redirect that carries the query string along, so a bookmark or
 * a notification link to a merged page still opens the same folder. `rewrite`
 * translates parameters whose meaning changed on the way. A hash in `to` is
 * kept, so a section of a merged page can be addressed.
 */
export default function RedirectWithQuery({
  to,
  rewrite,
}: {
  to: string
  rewrite?: (params: URLSearchParams) => URLSearchParams
}) {
  const { search } = useLocation()
  const [pathname, hash] = to.split('#')
  const params = new URLSearchParams(search)
  const qs = (rewrite ? rewrite(params) : params).toString()
  return <Navigate replace to={{ pathname, search: qs ? `?${qs}` : '', hash: hash ? `#${hash}` : '' }} />
}
