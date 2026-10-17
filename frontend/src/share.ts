// The PWA's share target (/share?title=&text=&url=): what another app shared
// to WeebSync, read as a link to a title or as a search.

/** The event the command palette listens to, to open prefilled with its detail. */
export const PALETTE_SEARCH_EVENT = 'ws:palette-search'

export type ShareTarget = { kind: 'title'; path: string } | { kind: 'search'; q: string } | { kind: 'none' }

const URL_RE = /https?:\/\/[^\s<>"']+/i

/** The first http(s) URL inside the shared fields (apps often put it in `text`). */
function findUrl(...parts: (string | null | undefined)[]): URL | null {
  for (const p of parts) {
    const m = p?.match(URL_RE)
    if (!m) continue
    try {
      return new URL(m[0])
    } catch {
      /* not a URL after all */
    }
  }
  return null
}

const host = (u: URL) => u.hostname.replace(/^www\./, '').toLowerCase()
const title = (source: string, id: string): ShareTarget => ({ kind: 'title', path: `/title/${source}/${id}` })
const searchOf = (q: string): ShareTarget => (q ? { kind: 'search', q } : { kind: 'none' })
// "Fullmetal_Alchemist-Brotherhood" -> "Fullmetal Alchemist Brotherhood"
const unslug = (s: string) => {
  try {
    return decodeURIComponent(s).replace(/[_-]+/g, ' ').trim()
  } catch {
    return s.replace(/[_-]+/g, ' ').trim()
  }
}

/** Where a shared payload leads: a known provider's title page, else a search. */
export function parseShare(params: URLSearchParams): ShareTarget {
  const text = [params.get('title'), params.get('text')].filter(Boolean).join(' ').trim()
  const u = findUrl(params.get('url'), params.get('text'), params.get('title'))
  if (u) {
    const h = host(u)
    const seg = u.pathname.split('/').filter(Boolean)
    if (h === 'anilist.co' && seg[0] === 'anime' && /^\d+$/.test(seg[1] ?? '')) return title('anilist', seg[1])
    if (h === 'themoviedb.org' && (seg[0] === 'tv' || seg[0] === 'movie')) {
      const id = seg[1]?.match(/^\d+/)?.[0]
      if (id) return title(`tmdb:${seg[0]}`, id)
    }
    if (h === 'thetvdb.com') {
      // by-id addresses only; the slugged ones carry no id, so they search
      if (seg[0] === 'dereferrer' && (seg[1] === 'series' || seg[1] === 'movie') && /^\d+$/.test(seg[2] ?? ''))
        return title(seg[1] === 'movie' ? 'tvdb:movie' : 'tvdb', seg[2])
      if ((seg[0] === 'series' || seg[0] === 'movies') && seg[1]) return searchOf(unslug(seg[1]))
    }
    // MyAnimeList ids are not AniList's: no direct page, the slug in the address names the show
    if (h === 'myanimelist.net' && seg[0] === 'anime')
      return searchOf(unslug(seg[2] ?? '') || text.replace(URL_RE, '').trim())
  }
  return searchOf(text.replace(URL_RE, '').trim() || u?.toString() || '')
}
