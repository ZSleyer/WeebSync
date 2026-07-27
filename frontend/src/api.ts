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

// Filesystem failures the backend classifies. Anything it did not recognize
// arrives as '' and stays a raw error string.
export type FsErrorCode = 'permission_denied' | 'disk_full' | 'read_only'

export const FS_ERROR_CODES: readonly string[] = ['permission_denied', 'disk_full', 'read_only']

// Identity the container writes files as. A "permission denied" on a mounted
// media directory is only fixable once the user knows which UID to grant.
export interface ContainerIdentity {
  uid: number
  gid: number
}

// The slice of GET /api/status the UI reads. The endpoint is admin-gated, so a
// non-admin session gets a 403 and the UI has to stay useful without it.
export interface SystemStatus {
  container: ContainerIdentity
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
  // classified reason behind `error`, when the backend recognized one. `error`
  // keeps the raw text; this is what the UI is allowed to branch on.
  errorCode?: FsErrorCode | string
  rateLimit: number
  bytesPerSec?: number
  createdAt: string
}

export interface Media {
  id: number
  title: { romaji: string; english: string; preferred?: string }
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

// CJK_RE matches Japanese/Chinese native script (kana, CJK ideographs, fullwidth
// forms) - a title we never want to display raw.
// eslint-disable-next-line no-control-regex
const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿＀-￯]/

// mediaTitle picks a displayable, non-Japanese title: romaji (romanized name, or
// the localized name for TMDB media) first, then english, skipping any candidate
// that is native kana/kanji. Falls back to whatever exists, then to `fallback`.
export function mediaTitle(
  m?: { title?: { preferred?: string; romaji?: string; english?: string } } | null,
  fallback = '',
): string {
  // the backend stores the canonical localized title in `preferred`; use it when
  // present, else fall back to a non-Japanese romaji/english heuristic.
  const preferred = m?.title?.preferred ?? ''
  if (preferred) return preferred
  const romaji = m?.title?.romaji ?? ''
  const english = m?.title?.english ?? ''
  for (const c of [romaji, english]) if (c && !CJK_RE.test(c)) return c
  return romaji || english || fallback
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
  plexAudioLang: string
  plexSubLang: string // "" = leave Plex alone, "off" = none, "Ger" = full, "Ger:forced" = forced
  plexStreamMiss?: string // what the files could not deliver: csv of "audio", "sub"
  langWaiting: number
  missing?: number[]
  unsorted?: number // episodes waiting in the collecting folder for the provider
  offset?: number
  intervalMin: number
  lastCheck: string
  nextCheck: number // unix seconds of the next scheduled check
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

// What a sync did. The counters answer the question a bare "0 queued" leaves
// open: nothing to do, or something wrong?
export interface SyncResult {
  queued: number
  ids?: number[]
  skipped?: number // already at the target, same size
  uploading?: number // still growing on the remote
  filtered?: number // dropped by the language filter
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

// DownloadGroup is one series folder's metadata, shared by every download from
// it. Kept out of Download because the SSE stream replaces that object per
// progress tick and would wipe anything added to it.
export interface DownloadGroup {
  serverId: number
  serverName?: string
  folder: string
  title?: string // empty when the folder has no catalog match
  cover?: string
  overview?: string
  providers?: string[]
  links: ProviderLinks
  watchId?: number
}

export interface DownloadItemMeta {
  g: string // group key
  season?: number
  episode?: number
  title?: string // episode title, only when the provider cache is warm
}

export interface DownloadMeta {
  groups: Record<string, DownloadGroup>
  items: Record<string, DownloadItemMeta> // by download id
}

// downloadLabel is what the queue puts on a download: the series and episode
// title when the metadata knows the folder, the bare file name when it does not.
// The episode marker comes back separately so a row can keep it out of the part
// that truncates - a long series title would otherwise eat exactly the piece
// that says which episode this is. One helper because the queue rows and the
// history rows must not drift apart.
export function downloadLabel(d: Download, meta?: DownloadMeta) {
  const item = meta?.items[String(d.id)]
  const group = item ? meta?.groups[item.g] : undefined
  const name = d.remotePath.split('/').pop() ?? d.remotePath
  if (!group?.title || !item?.episode) return { label: name, ep: '', name, group, item }
  const pad = (n: number) => String(n).padStart(2, '0')
  // a file without a season marker keeps its plain number rather than
  // pretending to be season 1
  const ep = item.season ? `S${pad(item.season)}E${pad(item.episode)}` : `E${item.episode}`
  return { label: [group.title, item.title].filter(Boolean).join(' - '), ep, name, group, item }
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
  status?: string // watchlist: CURRENT | PLANNING | COMPLETED
  showKey?: string // local Plex key (incomplete)
  season?: number // 0 = movie/base
  isMovie?: boolean
  progress?: number
  have?: number // incomplete: episodes present
  need?: number // incomplete: episodes through the sequel
  sequel?: Media
  plexFolder?: string
  library?: string // incomplete: the Plex library this came from, shown on the card
  sync?: SyncPlan // incomplete: where a one-off sync creates the season/movie folder
}

// SyncPlan is the pre-computed local target for a one-off sync of a suggestion:
// a series season into its Season folder under the show, a movie into its own
// subfolder. localPath empty = target unresolved (UI hides the button).
export interface SyncPlan {
  localPath: string
  template?: string
  subfolder: boolean
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

// One episode as the metadata provider lists it, flagged with whether the
// watch's local folder holds it. season is the LOCAL one, i.e. what is on disk.
export interface WatchEpisode {
  season: number
  episode: number
  absolute?: number
  local?: number // local number, only when a {episode-N} template renumbers it
  title?: string
  aired?: string // YYYY-MM-DD
  have: boolean
  upcoming?: boolean // dated in the future, so its absence is not a gap
}

// episodes is never null: without a provider the numbers from the local file
// names still explain the gap badge, and reason says why the titles are gone.
export interface WatchEpisodes {
  provider?: string // tvdb | tmdb
  seriesId?: number
  title?: string
  url?: string
  reason?: 'no_provider' | 'no_series' | 'provider_error'
  missing: number
  episodes: WatchEpisode[]
}

// One season - or the movie - of a show the library already holds. folder is a
// local directory, or a "plex:" key when the Plex path is not a shared mount.
export interface LocalSeason {
  season: number
  folder: string
  resRank: number
  isMovie?: boolean
}

export interface UpgradeSuggestion {
  key: string // dismiss key, form "unit:{showKey}:{season}", films carry a ":m" suffix
  seriesId?: number
  showKey: string
  season: number // 0 = movie/base
  isMovie?: boolean
  title: string
  from: UpgradeVariant // best LOCAL copy (Plex)
  to: UpgradeVariant // recommended REMOTE copy (best)
  options: UpgradeVariant[] // ALL remote copies
  improvesRes: boolean
  improvesSub: boolean
  improvesDub: boolean
  providers: string[]
  links: ProviderLinks
  cover?: string
  format?: string // MOVIE | TV | ...
  episodes?: number
  category: string // anime-movie | anime-tv | movie | tv, for grouping
  library?: string // the Plex library this copy lives in, shown on the card
  sync?: SyncPlan // where a one-off sync writes (into the existing local season/movie folder)
  localSeasons?: LocalSeason[] // every season of this show the library already has
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
  // parsed JSON error body, for endpoints that return more than {error}
  data?: unknown
  constructor(status: number, message: string, data?: unknown) {
    super(message)
    this.status = status
    this.data = data
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
    let data: unknown
    try {
      data = await res.json()
      const err = (data as { error?: string }).error
      if (err) msg = err
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg, data)
  }
  return res.json()
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', url, body, headers),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string, body?: unknown) => request<T>('DELETE', url, body),
}

// syncOutcome turns a sync result into one sentence. Empty when files were
// queued: then the queue itself is the answer. Otherwise it names the reason,
// because "0 queued" alone reads like a failure.
export function syncOutcome(
  r: SyncResult,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  if (r.queued > 0) return ''
  const parts: string[] = []
  if (r.skipped) parts.push(t('remote.syncSkipped', { count: r.skipped }))
  if (r.uploading) parts.push(t('remote.syncUploading', { count: r.uploading }))
  if (r.filtered) parts.push(t('remote.syncFiltered', { count: r.filtered }))
  if (!parts.length) return t('remote.syncNothing')
  return t('remote.syncNoneBecause', { reasons: parts.join(', ') })
}

// plexStreamOptions builds the values for a Plex language dropdown. Subtitles
// get both variants per language, because the forced track carries signs and
// foreign dialogue only and the full one carries everything: which of the two
// someone wants is a decision, not something derivable from the audio. Audio has
// no such split.
export function plexStreamOptions(codes: string[], subtitles: boolean): string[] {
  if (!subtitles) return codes
  return codes.flatMap((c) => [c, `${c}:forced`])
}

// plexStreamLabel renders a stored preference value. "Ger:forced" reads as
// "Ger (forced)"; everything else is its own label.
export function plexStreamLabel(value: string, t: (k: string) => string): string {
  const [code, variant] = value.split(':')
  if (variant !== 'forced') return value
  return `${code} (${t('watch.plexSubForced')})`
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
