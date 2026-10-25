import { useRef, useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Eye, Trash2 } from 'lucide-react'
import { Rail, SectionHeading } from 'fluid-lycoris'
import { api, downloadLabel, type Download, type DownloadMeta, type Watch } from '../../api'
import { useNow } from '../../hooks'
import { coverSet } from '../../images'
import { CoverImg } from '../../components/SmartImg'
import { filesLink } from '../../components/playLinks'
import { useSeriesModal } from '../../components/SeriesModal'
import ActionSheet, { type SheetAction } from '../../components/ActionSheet'
import Press from '../../components/Press'
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
 * series at its title; "Ältere" leads to the whole history. A right click, the
 * keyboard's menu key or a long press opens the download's menu - the queue's
 * own for a finished download: open the series, remove it.
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
  const qc = useQueryClient()
  // the queue's removal, call and invalidation alike; no onError of its own,
  // so a failure lands in the app's error toast like every other mutation
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/downloads/${id}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  })
  const [sheet, setSheet] = useState<{ id: number; title: string; actions: SheetAction[] } | null>(null)
  const tiles = useRef(new Map<number, HTMLButtonElement>())
  const ico = { size: '1.2em', 'aria-hidden': true } as const
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
                const when = fresh ? t('today.justNow') : t('dash.landed', { day: day(at) })
                const go = () => {
                  // the series opens at its title
                  if (watch?.media) open(seriesTarget(watch))
                  else {
                    navigate(filesLink(0, d.localPath.slice(0, d.localPath.lastIndexOf('/')) || '/'))
                  }
                }
                const menu = () => {
                  // Android sends its own contextmenu along with the long press
                  if (sheet?.id === d.id) return
                  // the sheet hands focus back to what had it when it opened:
                  // the tile, also after a right click or a finger that did not focus it
                  tiles.current.get(d.id)?.focus({ preventScroll: true })
                  const media = watch?.media ? watch : undefined
                  setSheet({
                    id: d.id,
                    title: [title, ep || label.name].filter(Boolean).join(', '),
                    actions: [
                      ...(media
                        ? [
                            {
                              key: 'series',
                              label: t('dash.openSeries'),
                              icon: <Eye {...ico} />,
                              onClick: () => open(seriesTarget(media)),
                            },
                          ]
                        : []),
                      {
                        key: 'remove',
                        label: t('dash.removeSelected'),
                        icon: <Trash2 {...ico} />,
                        danger: true,
                        onClick: () =>
                          remove.mutate(d.id, {
                            // the tile leaves the shelf: the focus moves on to
                            // its neighbour instead of falling to the page
                            onSuccess: () => {
                              const near = shelf[i + 1] ?? shelf[i - 1]
                              if (near) tiles.current.get(near.d.id)?.focus({ preventScroll: true })
                            },
                          }),
                      },
                    ],
                  })
                }
                // a mouse's right click, and the keyboard's context menu key
                // (MDN, Element: contextmenu event, read 2026-10-25)
                const onContextMenu = (e: MouseEvent) => {
                  e.preventDefault()
                  menu()
                }
                return (
                  <Press key={d.id} className="td-cell" onLongPress={menu}>
                    <button
                      ref={(el) => {
                        if (el) tiles.current.set(d.id, el)
                        else tiles.current.delete(d.id)
                      }}
                      type="button"
                      className="td-tile"
                      data-fresh={fresh || undefined}
                      // the caption and chips are decorative: the name carries what the tile shows
                      aria-label={[title, ep || label.name, item?.title, when].filter(Boolean).join(', ')}
                      onClick={go}
                      onContextMenu={onContextMenu}
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
                        <span className="td-when">{when}</span>
                      </span>
                    </button>
                  </Press>
                )
              })}
        </Rail>
      </div>
      {sheet && <ActionSheet title={sheet.title} actions={sheet.actions} onClose={() => setSheet(null)} />}
    </section>
  )
}
