import type { QueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { api, type CatalogResponse, type Entry, type Watch } from '../api'

// The containers the player accepts (transfer.VideoExt on the server).
export const isVideo = (name: string) => /\.(mkv|mp4|avi|ts|m2ts|webm|mov)$/i.test(name)

/** The player's address for a file: server 0 is the local library. */
export const playHref = (server: number, path: string) => `/play?server=${server}&path=${encodeURIComponent(path)}`

/**
 * What the viewer makes of a file; null for what it does not open. Comics,
 * EPUBs and spreadsheets are unpacked on the server (read.open), the rest is
 * streamed as is (viewMime in play.go).
 */
export type ViewKind = 'comic' | 'epub' | 'sheet' | 'pdf' | 'audio' | 'image' | 'text'
const VIEW_KINDS: [ViewKind, RegExp][] = [
  ['comic', /\.(cbz|cbr|zip|rar)$/i],
  ['epub', /\.epub$/i],
  ['sheet', /\.(ods|xlsx)$/i],
  ['pdf', /\.pdf$/i],
  ['audio', /\.(mp3|flac|m4a|m4b|aac|ogg|opus|wav|mka)$/i],
  ['image', /\.(jpe?g|png|gif|webp|avif|bmp)$/i],
  ['text', /\.(txt|nfo|md|log|cue|lrc|json|xml|csv|ini|diz|sfv)$/i],
]
export const viewKind = (name: string): ViewKind | null => VIEW_KINDS.find(([, re]) => re.test(name))?.[0] ?? null

/**
 * A volume read to its last page or chapter, remembered in this browser. The
 * reader marks it; "Read" on a manga watch skips what is marked.
 */
export const doneKey = (server: number, path: string) => `viewer.done:${server}:${path}`

/** The viewer's address for a file. */
export const viewHref = (server: number, path: string) => `/view?server=${server}&path=${encodeURIComponent(path)}`

/** Where the bytes of a file are served, for the viewers that read them as is. */
export const streamUrl = (server: number, path: string) =>
  `/api/play/stream?server=${server}&path=${encodeURIComponent(path)}`

/** Files at a folder; a jump remounts the page, so it starts from the link. */
export const filesLink = (serverId: number, path: string) =>
  `/files?${serverId ? `server=${serverId}` : 'source=local'}&path=${encodeURIComponent(path.replace(/^\//, ''))}`

/**
 * Back to wherever this screen was opened from - a card comes back from its
 * history entry - or, opened by a link with nothing in the app behind it, to
 * the fallback. React Router numbers the entries it made; the first is 0.
 */
export function useBack(fallback: string) {
  const nav = useNavigate()
  return () => ((history.state?.idx ?? 0) > 0 ? nav(-1) : nav(fallback, { replace: true }))
}

const up = (p: string) => p.slice(0, p.lastIndexOf('/'))

/** The local folder a watch fills. */
export const watchFolder = (w: Watch) =>
  w.subfolder ? `${w.localPath.replace(/\/$/, '')}/${w.remotePath.replace(/\/+$/, '').split('/').pop()}` : w.localPath

/**
 * The watch a file belongs to: the file lies in its local folder, or in its
 * remote folder on its server. A watch's local folder is relative to a
 * download root, the browser's paths are absolute, so the folder's tail decides.
 *
 * ponytail: the file must lie in the folder itself, not deeper; the catalog
 * lookup catches the rest.
 */
export const watchOf = (watches: Watch[], server: number, path: string) => {
  const dir = `/${up(path).replace(/^\/+/, '')}`
  return watches.find((w) => {
    const root = (server ? (w.serverId === server ? w.remotePath : '') : watchFolder(w)).replace(/^\/+|\/+$/g, '')
    return !!root && dir.endsWith(`/${root}`)
  })
}

/**
 * The title a file belongs to, as the catalog matched it: its folder, or the
 * one above for a season folder. The query is the Files page's, so a catalog
 * seen there answers from cache.
 */
export async function catalogTitle(qc: QueryClient, server: number, file: string) {
  const folder = up(file)
  for (const dir of [folder, up(folder)]) {
    if (!dir || dir === '/') break
    const list = up(dir).replace(/^\//, '')
    const cat = await qc.fetchQuery<CatalogResponse>({
      queryKey: ['catalog', server, list],
      queryFn: () => api.get(`/api/servers/${server}/catalog${list ? `?path=${encodeURIComponent('/' + list)}` : ''}`),
      staleTime: 5 * 60_000,
    })
    const it = cat.items.find((i) => i.entry.path === dir)
    if (it?.media) return { source: it.source, media: it.media, dir }
  }
  return null
}

/** The listing of a folder, local or on a server. Paths come back as the browse endpoints spell them. */
export const listFolder = (server: number, dir: string) =>
  api.get<Entry[]>(
    server
      ? `/api/servers/${server}/browse?path=${encodeURIComponent(dir || '/')}`
      : `/api/browse/local?path=${encodeURIComponent(dir)}`,
  )

const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, undefined, { numeric: true })

/** The videos of a folder in episode order. */
export const videosIn = (entries: Entry[]) => entries.filter((e) => !e.isDir && isVideo(e.name)).sort(byName)

/**
 * The first episode of a title folder: its first video, or - for a title split
 * into season folders - the first video of its first season.
 *
 * ponytail: one level down. A title nested deeper (Show/Season/Disc) starts from
 * its files view instead; go deeper when such a library turns up.
 */
export async function firstVideo(server: number, dir: string): Promise<string | null> {
  const entries = await listFolder(server, dir)
  const here = videosIn(entries)
  if (here.length) return here[0].path
  for (const sub of entries.filter((e) => e.isDir).sort(byName)) {
    const inner = videosIn(await listFolder(server, sub.path))
    if (inner.length) return inner[0].path
  }
  return null
}
