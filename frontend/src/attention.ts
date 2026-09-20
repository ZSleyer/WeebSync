import { fmtMissing, langLabel, type Watch } from './api'

type T = (key: string, opts?: Record<string, unknown>) => string

export interface AttentionChip {
  key: string
  tone: 'warn' | 'err'
  text: string
}

const fmtDay = (ts: number) => new Date(ts * 1000).toLocaleDateString([], { day: '2-digit', month: '2-digit' })

// dubWaitingLabel is the calm counterpart to the attention chips: the watch
// waits for its dub as expected, dated when the forecast has a date.
export function dubWaitingLabel(t: T, w: Watch): string {
  const lang = langLabel(w)
  if (w.dubExpectedAt) return t('watch.dubWaiting', { lang, date: fmtDay(w.dubExpectedAt) })
  return t('watch.dubWaitingNoDate', { lang })
}

// dubOverdueLabel: the forecast plus the grace has passed - the expected
// waiting became something to look at.
export function dubOverdueLabel(t: T, w: Watch): string {
  const lang = langLabel(w)
  if (w.dubExpectedAt) return t('watch.dubOverdue', { lang, date: fmtDay(w.dubExpectedAt) })
  return t('watch.dubOverdueNoDate', { lang })
}

// attentionInfo turns the backend's attention reasons into readable chips -
// the dashboard, the tile tooltip and the sr-only texts all speak from here.
export function attentionInfo(t: T, w: Watch): AttentionChip[] {
  return (w.attention ?? []).map((key) => {
    switch (key) {
      case 'checkFailed':
        return { key, tone: 'err' as const, text: t('dash.checkFailed') }
      case 'behind':
        return { key, tone: 'warn' as const, text: t('watch.behind', { count: w.behind }) }
      case 'missing':
        return {
          key,
          tone: 'err' as const,
          text: t('watch.missing', { count: w.missing!.length, eps: fmtMissing(w.missing!, w.offset) }),
        }
      case 'dubOverdue':
        return { key, tone: 'err' as const, text: dubOverdueLabel(t, w) }
      case 'langWaiting':
        return {
          key,
          tone: 'warn' as const,
          text: t('watch.langWaiting', { count: w.langWaiting, lang: langLabel(w) }),
        }
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
