import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { Rail, SectionHeading } from 'fluid-lycoris'
import { downloadLabel, type Download, type DownloadMeta, type Watch } from '../../api'
import { useNow } from '../../hooks'
import { coverSet } from '../../images'
import { CoverImg } from '../../components/SmartImg'
import { filesLink } from '../../components/playLinks'
import { useSeriesModal } from '../../components/SeriesModal'
import { endedAt, langChip } from './history'
import { seriesTarget, useRiseOnData } from './shared'

/** how far back "new here" reaches */
const NEW_DAYS = 7
/** at most this many tiles */
const NEW_MAX = 8
/** a download this young reads "just now" */
const FRESH_MS = 10 * 60_000
/** the tiles' rendered width, for the browser's pick from the srcset */
const TILE_SIZES = '(min-width: 64rem) 132px, 104px'

/** what the shelf holds: the newest landed episode per series, newest first */
export function newArrivals(downloads: Download[], meta: DownloadMeta | undefined, now: number) {
  const seen = new Set<string>()
  const out: { d: Download; label: ReturnType<typeof downloadLabel> }[] = []
  for (const d of downloads
    .filter((x) => x.status === 'done' && now - endedAt(x) < NEW_DAYS * 86_400_000)
    .sort((a, b) => endedAt(b) - endedAt(a))) {
    const label = downloadLabel(d, meta)
    const key = label.item?.g ?? d.remotePath
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ d, label })
    if (out.length >= NEW_MAX) break
  }
  return out
}

const resChip = (res?: number) => (!res ? '' : res >= 2160 ? '4K' : `${res}p`)

/**
 * "Neu da": what landed this week, one cover per series with the episode's
 * resolution and languages on it and its title under it. A tile opens the
 * series at that episode; "Ältere" leads to the whole history.
 */
export function NewShelf({
  downloads,
  meta,
  watches,
  loading,
}: {
  downloads: Download[]
  meta?: DownloadMeta
  watches: Watch[]
  loading: boolean
}) {
  const { t, i18n } = useTranslation()
  const now = useNow()
  const navigate = useNavigate()
  const { open } = useSeriesModal()
  const shelf = newArrivals(downloads, meta, now)
  const body = useRef<HTMLDivElement>(null)
  useRiseOnData(body, !loading)
  if (!loading && shelf.length === 0) return null
  const day = (ms: number) => new Date(ms).toLocaleDateString(i18n.language, { weekday: 'short' })
  return (
    <section aria-labelledby="td-new-h">
      <SectionHeading
        id="td-new-h"
        title={t('dash.newHere')}
        action={
          <Link to="/history" className="t-link">
            {t('today.older')}
          </Link>
        }
      />
      <div ref={body}>
        <Rail prevLabel={t('today.railPrev')} nextLabel={t('today.railNext')} shelfClassName="td-shelf">
          {loading
            ? [0, 1, 2, 3, 4].map((i) => (
                <span key={i} aria-hidden className="td-tile td-tile-sk">
                  <span className="td-cv" />
                  <span className="td-capt">
                    <span style={{ width: '80%' }} />
                    <span style={{ width: '45%' }} />
                    <span style={{ width: '65%' }} />
                    <span style={{ width: '40%' }} />
                  </span>
                </span>
              ))
            : shelf.map(({ d, label }, i) => {
                const { group, item } = label
                const watch = group?.watchId ? watches.find((w) => w.id === group.watchId) : undefined
                const title = group?.title || label.name
                const at = endedAt(d)
                const fresh = now - at < FRESH_MS
                const ep = item?.episode
                  ? item.season
                    ? t('today.epSeason', { s: item.season, e: item.episode })
                    : t('today.ep', { e: item.episode })
                  : ''
                const chips = [resChip(item?.res), ...(item?.dub ?? []).map(langChip)].filter(Boolean)
                const go = () => {
                  if (watch?.media) {
                    // the card opens at this episode: its facts open and the
                    // row is marked once (the card reads episode, season and
                    // the file's path)
                    const target = {
                      ...seriesTarget(watch),
                      tab: 'episodes' as const,
                      playPath: d.localPath,
                      episode: ep ? item?.episode : undefined,
                      season: item?.season || undefined,
                    }
                    open(target)
                  } else {
                    navigate(filesLink(0, d.localPath.slice(0, d.localPath.lastIndexOf('/')) || '/'))
                  }
                }
                return (
                  <button
                    key={d.id}
                    type="button"
                    className="td-tile"
                    data-fresh={fresh || undefined}
                    onClick={go}
                    aria-label={[title, ep, item?.title].filter(Boolean).join(', ')}
                  >
                    <span className="td-cv">
                      <CoverImg
                        set={coverSet({ large: group?.cover, extraLarge: group?.coverLarge })}
                        title={title}
                        sizes={TILE_SIZES}
                        eager={i < 4}
                        priority={false}
                      />
                      {chips.length > 0 && (
                        <span className="td-chips">
                          {chips.map((c) => (
                            <i key={c}>{c}</i>
                          ))}
                        </span>
                      )}
                    </span>
                    <span className="td-capt" aria-hidden>
                      <b>{title}</b>
                      <span>{ep || label.name}</span>
                      <span>{item?.title || '\u00a0'}</span>
                      <span className="td-when">{fresh ? t('today.justNow') : t('dash.landed', { day: day(at) })}</span>
                    </span>
                  </button>
                )
              })}
        </Rail>
      </div>
    </section>
  )
}
