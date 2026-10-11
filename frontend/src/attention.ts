import { epLabel, fmtEps, langLabel, type Watch } from './api'

type T = (key: string, opts?: Record<string, unknown>) => string

export interface AttentionChip {
  key: string
  tone: 'warn' | 'err'
  text: string
}

const fmtDay = (ts: number) => new Date(ts * 1000).toLocaleDateString([], { day: '2-digit', month: '2-digit' })

// the episode a dub watch waits for: the first one the filter held back, or
// the one after the last local file
function dubEpPrefix(t: T, w: Watch): string {
  const held = w.langWaitingEps?.[0]
  const ep = held ? epLabel(w, held.e, held.s) : w.dubNextEpisode ? epLabel(w, w.dubNextEpisode) : ''
  return ep ? `${t('watch.chipEp', { n: ep })} · ` : ''
}

// dubWaitingLabel is the calm counterpart to the attention chips: the watch
// waits for its dub as expected, dated when the forecast has a date.
export function dubWaitingLabel(t: T, w: Watch): string {
  const lang = langLabel(w)
  if (w.dubExpectedAt) return dubEpPrefix(t, w) + t('watch.dubWaiting', { lang, date: fmtDay(w.dubExpectedAt) })
  return dubEpPrefix(t, w) + t('watch.dubWaitingNoDate', { lang })
}

// dubOverdueLabel: the forecast plus the grace has passed - the expected
// waiting became something to look at.
export function dubOverdueLabel(t: T, w: Watch): string {
  const lang = langLabel(w)
  if (w.dubExpectedAt) return dubEpPrefix(t, w) + t('watch.dubOverdue', { lang, date: fmtDay(w.dubExpectedAt) })
  return dubEpPrefix(t, w) + t('watch.dubOverdueNoDate', { lang })
}

// behindLabel: aired but not on the source yet. A dub watch counts from
// after its last local file (the original's next airing runs ahead of the
// dub), any other from right before the next airing.
export function behindLabel(t: T, w: Watch): string {
  const n = w.behind ?? 0
  const first = w.dubNextEpisode ?? (w.nextEpisode ? w.nextEpisode - n : 0)
  if (!first) return t('watch.behind', { count: n })
  const eps = Array.from({ length: Math.min(n, 5) }, (_, i) => epLabel(w, first + i)).join(', ')
  return t('watch.behindEps', { count: n, eps })
}

// langWaitingLabel: the files the language filter held back, by episode when
// the names told which.
export function langWaitingLabel(t: T, w: Watch): string {
  const lang = langLabel(w)
  const eps = w.langWaitingEps ?? []
  if (!eps.length) return t('watch.langWaiting', { count: w.langWaiting, lang })
  return t('watch.langWaitingEps', { count: eps.length, lang, eps: fmtEps(w, eps) })
}

// missingLabel: the gaps inside what is local.
export function missingLabel(t: T, w: Watch): string {
  return t('watch.missing', { count: w.missing!.length, eps: fmtEps(w, w.missing!) })
}

// dubProgressLabel: a watch without a dub filter whose older files are
// dubbed and newer ones are not yet - how far the dub is and what comes next.
export function dubProgressLabel(t: T, w: Watch): string {
  const p = w.dubProgress!
  const opts = { lang: `${p.lang}-Dub`, have: p.have, total: p.total, ep: epLabel(w, p.next.e, p.next.s) }
  if (p.expectedAt) return t('watch.dubProgress', { ...opts, date: fmtDay(p.expectedAt) })
  return t('watch.dubProgressNoDate', opts)
}

// seasonLabel: the one season a watch's folder holds; '' for none or several
// (several name the season on every episode instead, see epLabel).
export function seasonLabel(t: T, w: Watch): string {
  return w.seasons?.length === 1 ? t('watch.gaps.season', { n: w.seasons[0] }) : ''
}

// attentionInfo turns the backend's attention reasons into readable chips -
// the dashboard, the tile tooltip and the sr-only texts all speak from here.
export function attentionInfo(t: T, w: Watch): AttentionChip[] {
  return (w.attention ?? []).map((key) => {
    switch (key) {
      case 'checkFailed':
        return { key, tone: 'err' as const, text: t('dash.checkFailed') }
      case 'behind':
        return { key, tone: 'warn' as const, text: behindLabel(t, w) }
      case 'missing':
        return { key, tone: 'err' as const, text: missingLabel(t, w) }
      case 'dubOverdue':
        return { key, tone: 'err' as const, text: dubOverdueLabel(t, w) }
      case 'langWaiting':
        return { key, tone: 'warn' as const, text: langWaitingLabel(t, w) }
      case 'unsorted':
        return { key, tone: 'warn' as const, text: t('watch.unsorted', { count: w.unsorted }) }
      case 'plexStreamMiss':
        return {
          key,
          tone: 'warn' as const,
          text: t('watch.plexMiss', {
            what: (w.plexStreamMiss ?? '')
              .split(',')
              .map((d) => t(d === 'audio' ? 'watch.plexAudio' : 'watch.plexSub'))
              .join(', '),
          }),
        }
      default:
        return { key, tone: 'warn' as const, text: key }
    }
  })
}
