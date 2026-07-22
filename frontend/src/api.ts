// Typed fetch helpers for the WeebSync API.

export interface User {
  id: number
  email: string
  isAdmin: boolean
}

export interface UserAccount {
  id: number
  email: string
  isAdmin: boolean
  createdAt: string
}

export interface ServerInfo {
  id: number
  name: string
  protocol: 'sftp' | 'ftps' | 'ftp'
  host: string
  port: number
  username: string
  rootPath: string
  maxConnections: number
}

export interface Entry {
  name: string
  path: string
  size: number
  isDir: boolean
  modTime: string
}

export interface Download {
  id: number
  userId: number
  serverId: number
  remotePath: string
  localPath: string
  size: number
  transferred: number
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'canceled'
  error?: string
  rateLimit: number
  bytesPerSec?: number
  createdAt: string
}

export interface Media {
  id: number
  title: { romaji: string; english: string }
  coverImage: { large: string }
  bannerImage: string
  trailer?: { id: string; site: string; thumbnail: string } | null
  nextAiringEpisode?: { airingAt: number; episode: number } | null
  episodes: number
  seasonYear: number
  format: string
  status: string
  averageScore: number
  genres: string[]
  description: string
  siteUrl?: string
}

export interface CatalogItem {
  entry: Entry
  media?: Media
  source?: string // anilist | tmdb:tv | tmdb:movie
  pending?: boolean // metadata still resolving in the background
  kind?: string // 'movie' | 'series' heuristic classification, '' = unknown
  local?: LocalStat // only in the local catalog: what the folder holds on disk
}

// LocalStat: contents of a local folder, counted at any depth.
export interface LocalStat {
  videos: number
  files: number
  bytes: number
  modTime?: string
}

export interface CatalogResponse {
  scope: string // '' = anime (AniList), 'tv' | 'movie' = TMDB
  items: CatalogItem[]
}

export interface Watch {
  id: number
  userId: number
  serverId: number
  serverName: string
  remotePath: string
  localPath: string
  mode: string
  template: string
  separator: string
  titleOverride: string
  pattern: string
  replacement: string
  subfolder: boolean
  mediaId: number
  mediaSource: string
  fromEpisode: number
  airedMapping: boolean
  renameProvider: string
  renameOrdering: string
  renameTitleLang: string
  renameSeriesId: number
  wantDub: string
  wantSub: string
  langWaiting: number
  missing?: number[]
  offset?: number
  intervalMin: number
  lastCheck: string
  lastResult: string // error text of the last check, '' on success
  lastQueued: number // files queued at the last check, -1 = none yet
  lastUploading: number
  createdAt: string
  media?: Media
  localFiles: number
  active: number
  complete: boolean
  nextEpisode?: number
  nextEpisodeAbs?: number
  behind?: number
  seenEpisodes?: number
  nextAiringAt?: number
  waiting: boolean
  airings?: Airing[]
  category?: 'anime-series' | 'anime-movie' | 'series' | 'movie'
}

export interface Airing {
  at: number // unix seconds
  episode: number // local numbering (offset applied)
  episodeAbs?: number // original absolute number when it differs
}

export interface ProviderLinks {
  anilist?: string
  tmdb?: string
  tvdb?: string
  imdb?: string
  plex?: string
}

export interface SuggestionCandidate {
  serverId: number
  serverName: string
  path: string
}

// SuggestionItem is one deduplicated suggestion (a single series regardless of
// how many providers surfaced it). category ∈ anime-movie|anime-tv|movie|tv.
export interface SuggestionItem {
  refKey: string // series:{id} | fold:{key}:{year} — the series-wide ignore key
  seriesId: number
  category: string
  title: string
  year?: number
  cover?: string
  media: Media
  providers: string[] // anilist | tmdb | tvdb | imdb | plex
  links: ProviderLinks
  candidates: SuggestionCandidate[]
  status?: string // watchlist: CURRENT | PLANNING
  progress?: number
  have?: number // incomplete: episodes present
  need?: number // incomplete: episodes through the sequel
  sequel?: Media
  plexFolder?: string
}

export interface SuggestionsResponse {
  watchlist: SuggestionItem[]
  trending: SuggestionItem[]
  upgrades: UpgradeSuggestion[]
  incomplete: SuggestionItem[]
  building: boolean
}

export interface UpgradeVariant {
  serverId: number
  serverName?: string // "" = local filesystem
  folder: string
  resRank: number // max video height, 0 = unknown
  dub: string[]
  sub: string[]
}

export interface UpgradeSuggestion {
  seriesId: number
  title: string
  from: UpgradeVariant // the weaker copy present
  to: UpgradeVariant // the better copy that exists elsewhere
  improvesRes: boolean
  improvesSub: boolean
  improvesDub: boolean
  providers: string[]
  links: ProviderLinks
  cover?: string
  format?: string // MOVIE | TV | ...
  episodes?: number
}

export interface UpgradeDims {
  res: boolean
  sub: boolean
  dub: boolean
}

export interface DismissedItem {
  kind: string
  refKey: string
  label: string
  dismissedAt: string
}

export interface PlexAccount {
  linked: boolean
  user?: string
}

export interface PlexLinkStart {
  id: number
  code: string
  url: string
}

export interface PlexWatchItem {
  title: string
  year: number
  type: string // show | movie
  tvdb: number
  tmdb: number
}

export interface Review {
  summary: string
  score: number // reviewer's 0-100 rating
  rating: number // upvotes (AniList only)
  user: { name: string; avatar?: { medium: string } }
}

export interface SearchResult {
  results: Entry[]
  indexed: number
}

export interface RenamePair {
  old: string
  new: string
  error?: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const h: Record<string, string> = { ...(headers ?? {}) }
  if (body !== undefined) h['Content-Type'] = 'application/json'
  const res = await fetch(url, {
    method,
    headers: Object.keys(h).length ? h : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = res.statusText
    try {
      const data = await res.json()
      if (data.error) msg = data.error
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg)
  }
  return res.json()
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', url, body, headers),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string, body?: unknown) => request<T>('DELETE', url, body),
}

// fmtMissing renders missing episode numbers, appending the original absolute
// number in parens when a renumber offset is active (e.g. "59 (1206)").
export function fmtMissing(missing: number[], offset?: number): string {
  return missing
    .slice(0, 5)
    .map((m) => (offset ? `${m} (${m - offset})` : `${m}`))
    .join(', ')
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = n
  let u = -1
  do {
    v /= 1024
    u++
  } while (v >= 1024 && u < units.length - 1)
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`
}

export function fmtSpeed(bps: number): string {
  return `${fmtBytes(bps)}/s`
}
