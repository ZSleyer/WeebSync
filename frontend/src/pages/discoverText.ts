// The words of an Entdecken row, built from the suggestion data. Pure, so the
// tests can hold the wording without rendering a page.

import type { UpgradeVariant } from '../api'
import { realLangs } from '../components/upgradeQuality'

type T = (k: string, o?: Record<string, unknown>) => string

/** The categories the backend sorts every title into. */
export const CATEGORIES = ['anime-tv', 'anime-movie', 'animation-tv', 'animation-movie', 'tv', 'movie'] as const

/**
 * A server path made short enough for a row: the first segment (the share
 * every path on that server starts with) and a trailing release tag in
 * brackets go, the rest stays.
 */
export function shortPath(p: string): string {
  return p
    .replace(/^\/[^/]+\//, '')
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .replace(/\/+$/, '')
}

/** The meta line under a title: "2026 · Anime-Serie · 12 Folgen · 84 %", leaving out what is unknown. */
export function metaLine(
  it: { year?: number; category?: string; episodes?: number; score?: number; library?: string },
  t: T,
): string {
  return [
    it.year ? String(it.year) : '',
    it.category && (CATEGORIES as readonly string[]).includes(it.category)
      ? t(`discover.cat.${it.category}`)
      : (it.library ?? ''),
    it.episodes && it.episodes > 0 ? t('discover.episodes', { count: it.episodes }) : '',
    it.score && it.score > 0 ? t('discover.score', { score: it.score }) : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * One copy's make-up in the compare boxes of an upgrade: "1080p · Ton Jpn ·
 * UT Eng+Ger wählbar". Unknown resolution and missing tracks are said, and a
 * subtitle burned into the picture is named as such.
 */
export function copyLine(v: Pick<UpgradeVariant, 'resRank' | 'dub' | 'sub' | 'soft'>, t: T): string {
  const res = !v.resRank ? t('discover.q.resUnknown') : v.resRank >= 2160 ? '4K' : `${v.resRank}p`
  const dub = realLangs(v.dub ?? [])
  const sub = realLangs(v.sub ?? [])
  const soft = sub.filter((c) => (v.soft ?? []).includes(c))
  const hard = sub.filter((c) => !soft.includes(c))
  const audio = dub.length ? t('discover.q.audio', { langs: dub.join('+') }) : t('discover.q.audioUnknown')
  let subs: string
  if (!sub.length) subs = t('discover.q.subNone')
  else if (!hard.length) subs = t('discover.q.subSoft', { langs: soft.join('+') })
  else if (!soft.length) subs = t('discover.q.subHard', { langs: hard.join('+') })
  else subs = t('discover.q.subMixed', { soft: soft.join('+'), hard: hard.join('+') })
  return [res, audio, subs].join(' · ')
}

/** Episode or watch progress: "gesehen 3 von 12", or just the count when the total is unknown. */
export function progressLine(seen: number, total: number, t: T): string {
  return total > 0 ? t('discover.seenOf', { seen, total }) : t('discover.seen', { seen })
}

/** Titles joined the way the language lists them ("A, B und C"). */
export function listOf(items: string[], lang: string): string {
  try {
    return new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' }).format(items)
  } catch {
    return items.join(', ')
  }
}

/** How current the lists are: "Stand von heute, 14:05" or "Stand vom 12.10., 09:30", with the recheck after it. */
export function asOfLine(ms: number, now: number, lang: string, t: T): string {
  const at = new Date(ms)
  const time = at.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
  if (at.toDateString() === new Date(now).toDateString()) return t('discover.asOfToday', { time })
  const date = at.toLocaleDateString(lang, { day: 'numeric', month: 'numeric' })
  return t('discover.asOfDay', { date, time })
}
