import { useStored } from '../hooks/useStored'

/** A saved folder: the local library or a server, and a path inside it. */
export interface Bookmark {
  source: 'local' | number
  path: string
}

export const BOOKMARKS_KEY = 'weebsync.files.bookmarks'

const norm = (p: string) => p.replace(/^\/+|\/+$/g, '')
const same = (a: Bookmark, b: Bookmark) => a.source === b.source && norm(a.path) === norm(b.path)

/** Reads the stored list; anything malformed is dropped, never thrown. */
export function parseBookmarks(raw: string): Bookmark[] {
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.flatMap((e: Partial<Bookmark> | null) =>
      e && (e.source === 'local' || (typeof e.source === 'number' && e.source > 0)) && typeof e.path === 'string'
        ? [{ source: e.source, path: norm(e.path) }]
        : [],
    )
  } catch {
    return []
  }
}

export const hasBookmark = (list: Bookmark[], b: Bookmark) => list.some((x) => same(x, b))

/** Adds a bookmark at the end; a folder already saved stays once. */
export const addBookmark = (list: Bookmark[], b: Bookmark): Bookmark[] =>
  hasBookmark(list, b) ? list : [...list, { source: b.source, path: norm(b.path) }]

export const removeBookmark = (list: Bookmark[], b: Bookmark): Bookmark[] => list.filter((x) => !same(x, b))

/** Bookmarks of this browser only: they live in localStorage, not on the server. */
export function useBookmarks() {
  const [raw, setRaw] = useStored<string>(BOOKMARKS_KEY, '[]')
  const list = parseBookmarks(raw)
  const save = (next: Bookmark[]) => setRaw(JSON.stringify(next))
  return {
    list,
    toggle: (b: Bookmark) => save(hasBookmark(list, b) ? removeBookmark(list, b) : addBookmark(list, b)),
    remove: (b: Bookmark) => save(removeBookmark(list, b)),
  }
}
