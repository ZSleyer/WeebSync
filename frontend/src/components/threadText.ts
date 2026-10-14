// AniList forum text, made safe and short. Pure functions: the thread
// reader renders their output as React nodes, never as HTML.

/** What a thread title says once the series' own names are gone. */
export interface ShortTitle {
  /** the title opened with "[Spoilers]" */
  spoiler: boolean
  /** the episode an "Episode N" thread discusses */
  episode?: number
  /** what is left: empty when the episode says it all */
  rest: string
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const EDGE = /^[\s\-–—:|·,/]+|[\s\-–—:|·,/]+$/g

/**
 * Shortens a thread title by what every thread of the series repeats: the
 * "[Spoilers]" prefix and the series' own names (any case), then lifts out
 * an "Episode N" so the list can name the episode in the reader's language.
 * Names shorter than three characters are left alone, they would cut words.
 */
export function shortThreadTitle(title: string, names: (string | undefined | null)[]): ShortTitle {
  let s = title
  const spoiler = /^\s*\[spoilers?\]/i.test(s)
  s = s.replace(/^\s*\[spoilers?\]\s*/i, '')
  const uniq = [...new Set(names.map((n) => n?.trim() ?? '').filter((n) => n.length >= 3))]
  // longest first: "Show Season 2" goes before "Show" can leave "Season 2"
  for (const n of uniq.sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(escape(n), 'gi'), ' ')
  }
  // every thread in the list is a discussion: the word says nothing there
  s = s.replace(/\bdiscussion\s*$/i, ' ')
  let episode: number | undefined
  // one episode only: "Episodes 1-4" stays as it is
  const ep = /\b(?:episode|ep\.?)\s*(\d{1,4})\b(?!\s*[-–]\s*\d)/i.exec(s)
  if (ep) {
    episode = Number(ep[1])
    s = s.replace(ep[0], ' ')
  }
  const rest = s.replace(/\s+/g, ' ').replace(EDGE, '').trim()
  return { spoiler, episode, rest }
}

/** One piece of a paragraph. */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'br' }
  | { kind: 'link'; href: string; text: string }
  | { kind: 'media'; media: 'image' | 'video'; href: string }
  | { kind: 'spoiler'; children: Inline[] }

// One pass over the text, longest constructs first. Every href the parser
// hands out matched https?:// here, so no javascript: or data: link can
// come out of it.
const URL_CHARS = String.raw`https?:\/\/[^\s<>()"'\]\[]+`
const TOKEN = new RegExp(
  [
    String.raw`~!([\s\S]*?)!~`, // 1 spoiler
    String.raw`img\d*%?\s*\(\s*(${URL_CHARS})\s*\)`, // 2 image
    String.raw`(youtube|webm)\s*\(\s*([^\s()]+)\s*\)`, // 3 kind, 4 target
    String.raw`\[([^\]\n]*)\]\(\s*(${URL_CHARS})\s*\)`, // 5 text, 6 url
    String.raw`(${URL_CHARS}[^\s<>()"'.,!?:;\]\[])`, // 7 bare url
  ].join('|'),
  'gi',
)

/** Markers AniList draws as formatting, dropped to plain text. */
function plain(s: string): string {
  return (
    s
      // HTML AniList passes through: line breaks stay, every other tag goes
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/~~~/g, '')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_]([^*_\s][^*_\n]*?)[*_](?=[\s).,!?:]|$)/gm, '$1$2')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s{0,3}([-*_])\1{2,}\s*$/gm, '')
  )
}

function textTokens(s: string, out: Inline[]) {
  const parts = plain(s).split('\n')
  parts.forEach((p, i) => {
    if (i > 0) out.push({ kind: 'br' })
    if (p) out.push({ kind: 'text', text: p })
  })
}

function video(kind: string, target: string): string | undefined {
  if (/^https?:\/\//i.test(target)) return target
  // youtube(id): the bare id AniList also accepts
  if (kind.toLowerCase() === 'youtube' && /^[\w-]{6,20}$/.test(target)) {
    return `https://www.youtube.com/watch?v=${target}`
  }
  return undefined
}

/** The inline pieces of a piece of AniList markdown. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  const re = new RegExp(TOKEN.source, TOKEN.flags)
  let at = 0
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > at) textTokens(src.slice(at, m.index), out)
    at = m.index + m[0].length
    if (m[1] !== undefined) out.push({ kind: 'spoiler', children: parseInline(m[1].trim()) })
    else if (m[2]) out.push({ kind: 'media', media: 'image', href: m[2] })
    else if (m[3]) {
      const href = video(m[3], m[4])
      if (href) out.push({ kind: 'media', media: 'video', href })
    } else if (m[6]) out.push({ kind: 'link', href: m[6], text: plain(m[5]).trim() || m[6] })
    else if (m[7]) out.push({ kind: 'link', href: m[7], text: m[7] })
  }
  if (at < src.length) textTokens(src.slice(at), out)
  return out
}

/**
 * AniList markdown as paragraphs of inline pieces. A blank line parts
 * paragraphs, except inside a spoiler, which stays one piece wherever it
 * breaks its lines.
 */
export function parseThreadText(src: string): Inline[][] {
  const flat = parseInline(src.replace(/\r/g, '').trim())
  const paras: Inline[][] = [[]]
  for (let i = 0; i < flat.length; i++) {
    const tok = flat[i]
    const cur = paras[paras.length - 1]
    if (tok.kind === 'br' && flat[i + 1]?.kind === 'br') {
      while (flat[i + 1]?.kind === 'br') i++
      if (cur.length) paras.push([])
      continue
    }
    if (tok.kind === 'br' && !cur.length) continue
    cur.push(tok)
  }
  while (paras.length && !paras[paras.length - 1].length) paras.pop()
  // a trailing line break inside a paragraph only adds height
  for (const p of paras) while (p[p.length - 1]?.kind === 'br') p.pop()
  return paras
}

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.35],
  ['month', 12],
  ['year', Infinity],
]

/** "vor 3 Tagen": unix seconds against now (ms), in the reader's language. */
export function relTime(ts: number, now: number, lang: string): string {
  let v = ts - now / 1000
  for (const [unit, size] of STEPS) {
    if (Math.abs(v) < size) return new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(Math.trunc(v), unit)
    v /= size
  }
  return ''
}
