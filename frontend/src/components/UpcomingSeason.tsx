import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Badge, Cover, Panel } from '@weebsync/design-system'
import { mediaTitle, type Media } from '../api'
import { countdown } from '../countdown'
import { useSeriesModal } from './SeriesModal'

// Expected is when a not-yet-uploaded series should turn up, at the precision
// the provider knows it: an exact broadcast slot, a day, a month, or nothing.
// `at` (ms) only orders the list; undated titles sort last.
export interface Expected {
  label: string
  tone: 'neutral' | 'accent' | 'warn'
  at: number
}

// expectedOf words the wait for one series. Every date is AniList's announced
// one: broadcasts slip and release groups lag behind them, so a passed date
// reads as "upload pending" rather than as an error, and a date-only start
// says "expected" instead of counting down to an hour nobody announced.
export function expectedOf(t: TFunction, m: Media, lang: string, now = Date.now()): Expected {
  const next = m.nextAiringEpisode
  // already on air (the backend only keeps freshly started ones): the folder
  // is late, not the series
  if (m.status === 'RELEASING') return { label: t('upcoming.uploadPending'), tone: 'warn', at: 0 }
  if (next) {
    const at = next.airingAt * 1000
    if (at <= now) return { label: t('upcoming.uploadPending'), tone: 'warn', at }
    return { label: countdown(t, next.airingAt, false, now), tone: 'accent', at }
  }
  const d = m.startDate ?? 0
  const year = Math.floor(d / 10000)
  const month = Math.floor(d / 100) % 100
  const day = d % 100
  if (year && month && day) {
    const date = new Date(year, month - 1, day)
    if (date.getTime() + 86_400_000 <= now)
      return { label: t('upcoming.uploadPending'), tone: 'warn', at: date.getTime() }
    return {
      label: t('upcoming.expected', { when: date.toLocaleDateString(lang, { day: 'numeric', month: 'short' }) }),
      tone: 'neutral',
      at: date.getTime(),
    }
  }
  if (year && month) {
    const date = new Date(year, month - 1, 1)
    return {
      label: t('upcoming.expected', { when: date.toLocaleDateString(lang, { month: 'long', year: 'numeric' }) }),
      tone: 'neutral',
      // a month-only date sorts after the dated starts within it
      at: new Date(year, month, 0).getTime(),
    }
  }
  return { label: t('upcoming.undated'), tone: 'neutral', at: Number.MAX_SAFE_INTEGER }
}

// UpcomingSeason lists the series of a season folder's season that the server
// doesn't carry yet, apart from the ones it does, each with when to expect it.
export default function UpcomingSeason({ media }: { media: Media[] }) {
  const { t, i18n } = useTranslation()
  const series = useSeriesModal()
  if (media.length === 0) return null
  const rows = media.map((m) => ({ m, e: expectedOf(t, m, i18n.language) })).sort((a, b) => a.e.at - b.e.at)
  return (
    <section className="mt-8" aria-labelledby="upcoming-heading">
      <h2 id="upcoming-heading" className="text-sm font-medium text-t-primary">
        {t('upcoming.title', { count: media.length })}
      </h2>
      <p className="mb-3 text-xs text-t-muted">{t('upcoming.hint')}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
        {rows.map(({ m, e }) => {
          const name = mediaTitle(m)
          return (
            <Panel as="article" key={m.id} className="group flex flex-col overflow-clip">
              <button
                className="text-left"
                onClick={() => series.open({ source: 'anilist', id: m.id, media: m })}
                aria-label={t('remote.detailsFor', { name })}
              >
                <Cover
                  size="fill"
                  src={m.coverImage.extraLarge || m.coverImage.large}
                  loading="lazy"
                  className="opacity-60 grayscale-[40%] transition group-hover:opacity-90 group-hover:grayscale-0"
                />
                <div className="p-2">
                  <h3 className="line-clamp-2 text-sm font-medium text-t-primary" title={name}>
                    {name}
                  </h3>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    <Badge tone={e.tone}>{e.label}</Badge>
                  </div>
                </div>
              </button>
            </Panel>
          )
        })}
      </div>
    </section>
  )
}
