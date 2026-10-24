import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  api,
  type Download,
  type DownloadMeta,
  type PlexMe,
  type DetectedMarks,
  type ServerInfo,
  type Watch,
} from '../../api'
import { useAuth, useNow, usePersistedQuery } from '../../hooks'
import { buildNeeds, hiddenNeeds } from './needs'

/**
 * What the Today page's needs are built from. The shell reads it for the
 * app badge and the page for its rows: the query keys are the same, so the
 * two observers share one request each, whichever page is open.
 */
export function useNeedsData() {
  const now = useNow()
  const dl = useQuery<Download[]>({
    queryKey: ['downloads'],
    queryFn: () => api.get('/api/downloads'),
    refetchInterval: 5000,
  })
  const { data: downloads = [], isLoading } = dl
  const { data: meta } = useQuery<DownloadMeta>({
    queryKey: ['downloads', 'meta'],
    queryFn: () => api.get('/api/downloads/meta'),
    staleTime: 60_000,
    refetchInterval: 60_000,
  })
  const wq = usePersistedQuery<Watch[]>('watches', () => api.get('/api/watches'), { refetchInterval: () => 30_000 })
  const { data: watches = [], isLoading: watchesLoading } = wq
  // no answer yet and the last try failed: an empty list here is not "nothing open"
  const failed = (dl.isError && dl.data === undefined) || (wq.isError && wq.data === undefined)
  const retry = () => Promise.all([dl.isError && dl.refetch(), wq.isError && wq.refetch()])
  // folders WeebSync marked on its own since the user last looked at the list
  const { data: marks } = useQuery<DetectedMarks>({
    queryKey: ['detected-marks'],
    queryFn: () => api.get('/api/catalog/detected-marks'),
    staleTime: 5 * 60_000,
  })
  const detected = marks?.unseen ?? 0
  // an admin whose Plex runs on a pasted token is asked to sign in with Plex
  // instead; a token from the environment cannot be changed here, so no ask
  const { data: me } = useAuth()
  const { data: plexMe } = useQuery<PlexMe>({
    queryKey: ['plex-me'],
    queryFn: () => api.get('/api/plex/me'),
    enabled: !!me?.isAdmin,
    staleTime: 5 * 60_000,
  })
  const plexToken = !!plexMe?.configured && plexMe.auth === 'token' && plexMe.kind !== 'jellyfin'
  const mediaChoose = !!plexMe?.choose
  const { data: servers = [] } = useQuery<ServerInfo[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/api/servers'),
    staleTime: 60_000,
  })
  const ftpServers = servers.filter((x) => x.protocol === 'ftp')
  return {
    now,
    downloads,
    isLoading,
    meta,
    watches,
    watchesLoading,
    detected,
    plexToken,
    mediaChoose,
    ftpServers,
    failed,
    retry,
  }
}

/** How many rows the Today page's needs list shows, hidden ones left out. */
export function useNeedCount(): number {
  const { t } = useTranslation()
  const { now, downloads, meta, watches, detected, plexToken, mediaChoose, ftpServers } = useNeedsData()
  const hidden = hiddenNeeds()
  return buildNeeds(t, { downloads, meta, watches, detected, now, plexToken, mediaChoose, ftpServers }).filter(
    (n) => !hidden.has(n.print),
  ).length
}
