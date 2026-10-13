// Where each video was left, and which ones were watched to the end, kept on
// this device: the player offers to go on where it stopped, and the episode
// list marks what was seen even without an AniList entry behind the title.
// One map in localStorage, pruned to the newest entries.

const KEY = 'weebsync.player.pos'
/** entries kept: the most recently touched ones */
const KEEP = 300
/** a position this close to either end is no place to resume from */
const EDGE = 2
/** the share of a video that counts as watched */
export const SEEN_AT = 0.9

interface Mark {
  /** seconds into the file, 0 when nothing to resume */
  at: number
  /** watched to SEEN_AT at least once */
  seen?: boolean
  /** when it was written, for pruning */
  t: number
}

const keyOf = (server: number, path: string) => `${server}:${path}`

function load(): Record<string, Mark> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Mark>) : {}
  } catch {
    return {}
  }
}

function save(all: Record<string, Mark>) {
  const entries = Object.entries(all)
  const kept = entries.length > KEEP ? Object.fromEntries(entries.sort((a, b) => b[1].t - a[1].t).slice(0, KEEP)) : all
  try {
    localStorage.setItem(KEY, JSON.stringify(kept))
  } catch {
    // storage can be full or off: the position is a convenience
  }
}

/** The point to offer resuming from, or null when the position is too close to an end. */
export function resumeFrom(at: number, duration: number): number | null {
  if (!(at > EDGE)) return null
  if (duration > 0 && at >= duration - EDGE) return null
  return at
}

/** The stored position of a file, 0 when none. */
export function savedPosition(server: number, path: string): number {
  return load()[keyOf(server, path)]?.at ?? 0
}

/** Remembers how far a file was played; the end of the file clears the position. */
export function storePosition(server: number, path: string, at: number, duration: number) {
  const all = load()
  const k = keyOf(server, path)
  const prev = all[k]
  const keep = resumeFrom(at, duration) ?? 0
  if (!keep && !prev?.seen) delete all[k]
  else all[k] = { ...prev, at: keep, t: Date.now() }
  save(all)
}

/** Marks a file as watched on this device. */
export function markSeen(server: number, path: string) {
  const all = load()
  const k = keyOf(server, path)
  all[k] = { at: all[k]?.at ?? 0, seen: true, t: Date.now() }
  save(all)
}

/** Whether a file was watched on this device. */
export function wasSeen(server: number, path: string): boolean {
  return !!load()[keyOf(server, path)]?.seen
}
