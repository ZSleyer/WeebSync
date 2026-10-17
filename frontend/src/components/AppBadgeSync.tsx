import { useAppBadge } from '../appBadge'
import { useNeedCount } from '../pages/today/useNeedsData'

/**
 * Keeps the installed app's icon on what waits for the user, on every page.
 * A component of its own so the shell does not re-render with each poll of
 * the queries it reads.
 */
export default function AppBadgeSync() {
  useAppBadge(useNeedCount())
  return null
}
