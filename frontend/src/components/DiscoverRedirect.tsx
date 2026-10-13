import { Navigate, useLocation, useSearchParams } from 'react-router'
import { discoverPath, lastSection, legacyDiscoverPath, sectionOf } from '../discoverRoutes'

/** An old /suggestions address: the same section under /discover. */
export function LegacySuggestions() {
  const { pathname, search, hash } = useLocation()
  return <Navigate replace to={legacyDiscoverPath(pathname + search + hash)} />
}

/**
 * /discover itself opens a section: the one the user had open last on this
 * browser, Merkliste the first time. `?tab=` from the old single page still
 * names its section.
 */
export function DiscoverIndex() {
  const [params] = useSearchParams()
  const id = sectionOf(params.get('tab')) ?? lastSection()
  return <Navigate replace to={discoverPath(id)} />
}
