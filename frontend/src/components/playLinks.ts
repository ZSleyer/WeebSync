import { api, type Entry } from '../api'

// The containers the player accepts (transfer.VideoExt on the server).
export const isVideo = (name: string) => /\.(mkv|mp4|avi|ts|m2ts|webm|mov)$/i.test(name)

/** The player's address for a file: server 0 is the local library. */
export const playHref = (server: number, path: string) => `/play?server=${server}&path=${encodeURIComponent(path)}`

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
