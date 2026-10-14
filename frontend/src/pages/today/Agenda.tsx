import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { SectionHeading } from 'fluid-lycoris'
import type { Watch } from '../../api'
import { episodeLabel, upcomingAirings, type Airing } from '../../airings'
import { watchTitle } from '../../api'
import { useNow } from '../../hooks'
import { useSeriesModal } from '../../components/SeriesModal'
import { daysAgo } from './history'
import { seriesTarget, useFold, useRiseOnData } from './shared'

type T = (key: string, opts?: Record<string, unknown>) => string

/** how many releases ahead the list shows */
const AHEAD = 4
/** under this the state counts hours and minutes, beyond it days */
const HOURS_SPAN = 20 * 3_600_000

/** The state of a release: how long until it, or that it ran (and landed). */
export function airingState(t: T, at: number, have: boolean | undefined, now: number): { text: string; ok?: boolean } {
  const ms = at - now
  if (ms <= 0) return have ? { text: t('today.landed'), ok: true } : { text: t('today.aired') }
  if (ms < HOURS_SPAN) {
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    return { text: t('today.inHours', { h, mm: String(m).padStart(2, '0') }) }
  }
  return { text: t('today.inDays', { count: Math.max(1, -daysAgo(at, now)) }) }
}

/** today's releases split at now, then the next few of the days after */
export function agendaRows(airings: Airing[], now: number) {
  const today = airings.filter((a) => daysAgo(a.at * 1000, now) === 0)
  const past = today.filter((a) => a.at * 1000 <= now)
  const ahead = today.filter((a) => a.at * 1000 > now)
  const later = airings.filter((a) => daysAgo(a.at * 1000, now) < 0).slice(0, AHEAD)
  return { past, ahead, later }
}

/**
 * "Heute im Programm": today's releases with a line where now is, the earlier
 * ones above it saying whether they landed. "Demnächst" below it: the next
 * few of the days after. A row opens its series.
 */
export function Agenda({ watches, loading }: { watches: Watch[]; loading: boolean }) {
  const { t, i18n } = useTranslation()
  const now = useNow()
  const { open } = useSeriesModal()
  const body = useRef<HTMLDivElement>(null)
  useRiseOnData(body, !loading)
  const fold = useFold('agenda')
  const foldSoon = useFold('soon')
  const { past, ahead, later } = agendaRows(upcomingAirings(watches, now, 7), now)
  const hm = (ms: number) => new Date(ms).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
  const when = (ms: number) =>
    daysAgo(ms, now) === 0
      ? hm(ms)
      : `${new Date(ms).toLocaleDateString(i18n.language, { weekday: 'short' })} ${hm(ms)}`
  const row = (a: Airing, isPast: boolean) => {
    const st = airingState(t, a.at * 1000, a.have, now)
    const inner = (
      <>
        <time dateTime={new Date(a.at * 1000).toISOString()}>{when(a.at * 1000)}</time>
        <span className="t-row-t">
          <strong>{watchTitle(a.watch)}</strong>
          <span title={a.est ? t('watch.dubEstimate') : undefined}>{episodeLabel(t, a)}</span>
        </span>
        <span className="td-state" data-ok={st.ok || undefined}>
          {st.text}
        </span>
      </>
    )
    return (
      <li key={`${a.watch.id}-${a.episode}-${a.at}-${a.dub ?? ''}`} className={`t-row${isPast ? ' td-past' : ''}`}>
        {a.watch.media ? (
          <button type="button" className="t-row-in" onClick={() => open(seriesTarget(a.watch))}>
            {inner}
          </button>
        ) : (
          <div className="t-row-in">{inner}</div>
        )}
      </li>
    )
  }
  return (
    <>
      <section aria-labelledby="td-agenda-h">
        <SectionHeading id="td-agenda-h" tone="accent-2" title={t('today.agenda')} fold={fold} />
        <div ref={body} id={fold.controls} hidden={!fold.open}>
          <ul className="t-rows t-rows--dense td-agenda">
            {loading ? (
              [0, 1, 2].map((i) => <li key={i} aria-hidden className="td-sk-row" />)
            ) : (
              <>
                {past.map((a) => row(a, true))}
                {/* only where it parts the day: above an empty rest or under
                    nothing earlier it marks nothing */}
                {past.length > 0 && ahead.length > 0 && (
                  <li className="td-now">
                    <span aria-hidden>{hm(now)}</span>
                    <span className="sr-only">{t('today.nowAt', { time: hm(now) })}</span>
                  </li>
                )}
                {ahead.map((a) => row(a, false))}
                {ahead.length === 0 && <li className="td-empty">{t('today.noneLeft')}</li>}
              </>
            )}
          </ul>
        </div>
      </section>
      <section aria-labelledby="td-soon-h">
        <SectionHeading
          id="td-soon-h"
          tone="accent-2"
          title={t('today.soon')}
          fold={foldSoon}
          action={
            <Link to="/watches?view=calendar" className="t-link t-link--2">
              {t('today.week')}
            </Link>
          }
        />
        <ul className="t-rows t-rows--dense td-agenda" id={foldSoon.controls} hidden={!foldSoon.open}>
          {loading ? (
            [0, 1].map((i) => <li key={i} aria-hidden className="td-sk-row" />)
          ) : later.length > 0 ? (
            later.map((a) => row(a, false))
          ) : (
            <li className="td-empty">{t('dash.upNextEmpty')}</li>
          )}
        </ul>
      </section>
    </>
  )
}
