import { Navigate, useLocation } from 'react-router'
import { legacyDiscoverPath } from '../discoverRoutes'

/** An old /suggestions address: the same section under /discover. */
export function LegacySuggestions() {
  const { pathname, search, hash } = useLocation()
  return <Navigate replace to={legacyDiscoverPath(pathname + search + hash)} />
}
