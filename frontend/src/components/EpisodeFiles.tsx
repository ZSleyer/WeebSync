import { useEffect, useRef } from 'react'
import { Play } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Divider } from '@weebsync/design-system'
import { fmtBytes, type Entry } from '../api'
import Loading from './Loading'
import { listFolder, videosIn } from './playLinks'

/** A folder a title's episodes lie in: the local library (server 0) or a server. */
export interface EpisodeFolder {
  server: number
  path: string
}

interface Group {
  label: string
  files: Entry[]
}

// the season and episode a file name carries, for the row's leading number
const SXE = /S(\d{1,2})\s*E(\d{1,4})/i
const pad = (n: string) => n.padStart(2, '0')

/** A folder's videos and those of its season folders, one level down. */
async function episodeGroups(f: EpisodeFolder): Promise<Group[]> {
  const entries = await listFolder(f.server, f.path)
  const groups: Group[] = []
  const here = videosIn(entries)
  if (here.length) groups.push({ label: '', files: here })
  const seasons = entries
    .filter((e) => e.isDir)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  for (const s of seasons) {
    const files = videosIn(await listFolder(f.server, s.path))
    if (files.length) groups.push({ label: s.name, files })
  }
  return groups
}

/**
 * The episodes of a title that are there to watch, each with its play button:
 * the title card's "Episodes" section. One list per folder the title lives in,
 * grouped by season folder. The file the card was opened for is marked and
 * scrolled to.
 */
export default function EpisodeFiles({
  folder,
  highlight,
  onPlay,
}: {
  folder: EpisodeFolder
  highlight?: string
  onPlay: (server: number, path: string) => void
}) {
  const { t } = useTranslation()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['episode-files', folder.server, folder.path],
    queryFn: () => episodeGroups(folder),
    staleTime: 60_000,
  })
  const marked = useRef<HTMLLIElement>(null)
  useEffect(() => {
    // the card jumps to this section itself; a long list still brings the
    // marked file into view
    marked.current?.scrollIntoView({ block: 'nearest' })
  }, [data, highlight])

  if (isLoading) return <Loading />
  if (isError) return <p className="text-sm text-err">{t('series.episodesError')}</p>
  if (!data?.length) return <p className="text-sm text-t-muted">{t('series.noEpisodes')}</p>
  return (
    <div className="grid gap-3">
      {data.map((g) => (
        <div key={g.label}>
          {(data.length > 1 || g.label) && <Divider label={g.label || t('series.thisFolder')} />}
          <ul className="-mx-2">
            {g.files.map((e) => {
              const m = SXE.exec(e.name)
              const here = e.path === highlight
              return (
                <li
                  key={e.path}
                  ref={here ? marked : undefined}
                  className={`t-ep-file ${here ? 't-ep-file--here' : ''}`}
                  aria-current={here ? 'true' : undefined}
                >
                  <button
                    type="button"
                    className="t-ep-file__play"
                    aria-label={t('player.playItem', { name: e.name })}
                    onClick={() => onPlay(folder.server, e.path)}
                  >
                    <span className="t-ep-file__icon" aria-hidden>
                      <Play size="0.9em" fill="currentColor" strokeWidth={0} />
                    </span>
                    {m && (
                      <span className="shrink-0 font-mono text-xs tabular-nums text-t-secondary">
                        S{pad(m[1])}E{pad(m[2])}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate" title={e.name}>
                      {e.name.replace(/\.[^.]+$/, '')}
                    </span>
                    <span className="hidden shrink-0 font-mono text-[11px] text-t-faint sm:inline">
                      {fmtBytes(e.size)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
