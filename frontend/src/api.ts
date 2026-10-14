// Typed fetch helpers for the WeebSync API.

import i18n from 'i18next'
import type { Schemas } from './api.gen'

export type User = Schemas['api.MeResponse']

export type UserAccount = Schemas['api.userInfo']

export type ServerInfo = Schemas['api.serverInfo']

// A folder's catalog mark and the scope rule around it.
export type ScopeInfo = Schemas['api.scopeResponse']
export type ScopeRule = Schemas['api.scopeRule']
export type ScopeHint = Schemas['api.scopeHint']

// Which folder a sync creates below the target: none, one named after the
// remote folder, or one named after the series title.
export type SubfolderMode = Schemas['api.KindDefaults']['subfolderSource']

// What a new auto-sync starts from, per media kind and shared.
export type KindDefaults = Schemas['api.KindDefaults']

export type WatchDefaults = Schemas['api.WatchDefaults']

export type Entry = Schemas['remote.Entry']

// Filesystem failures the backend classifies. Anything it did not recognize
// arrives as '' and stays a raw error string.
export type FsErrorCode = 'permission_denied' | 'disk_full' | 'read_only' | 'rename_failed'

export const FS_ERROR_CODES: readonly string[] = ['permission_denied', 'disk_full', 'read_only', 'rename_failed']

// Identity the container writes files as. A "permission denied" on a mounted
// media directory is only fixable once the user knows which UID to grant.
export type ContainerIdentity = Schemas['api.statusContainer']

// The slice of GET /api/status the UI reads. The endpoint is admin-gated, so a
// non-admin session gets a 403 and the UI has to stay useful without it.
export interface SystemStatus {
  container: ContainerIdentity
  disk?: DiskUsage
  // every filesystem the library spans, the download root first
  disks?: DiskUsage[]
}

export type DiskUsage = Schemas['api.statusDisk']

// Background job families, as /api/jobs reports them. Every signed-in user may
// see THAT work is running; pausing and stopping are admin-only endpoints.
export type JobsStatus = Schemas['api.JobsStatus']

export type Download = Schemas['transfer.Download']

export type Media = Schemas['anilist.Media']

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

export type CatalogItem = Schemas['api.catalogItem']

// LocalStat: contents of a local folder, counted at any depth.
export type LocalStat = Schemas['api.LocalStat']

export type CatalogResponse = Schemas['api.catalogResponse']

export type Watch = Schemas['api.Watch']

// Explanations: why a folder got its series, what a name says, what a watch
// waits for. Computed on request, nothing of it is stored.
export type CatalogExplain = Schemas['api.catalogExplainResponse']
export type NameExplain = Schemas['api.nameExplainResponse']
export type NamePiece = Schemas['api.namePiece']
export type WatchExplain = Schemas['api.watchExplainResponse']
export type WatchCheck = Schemas['api.WatchCheckResponse']
export type SessionInfo = Schemas['api.sessionInfo']

// What a sync did. The counters answer the question a bare "0 queued" leaves
// open: nothing to do, or something wrong?
export type SyncResult = Schemas['api.DownloadCreateResponse']

export type Airing = Schemas['api.Airing']

export type ProviderLinks = Schemas['api.ProviderLinks']

// DownloadGroup is one series folder's metadata, shared by every download from
// it. Kept out of Download because the SSE stream replaces that object per
// progress tick and would wipe anything added to it.
export type DownloadGroup = Schemas['api.DownloadGroup']

export type DownloadItemMeta = Schemas['api.DownloadItemMeta']

export type DownloadMeta = Schemas['api.DownloadMetaResponse']

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

export type SuggestionCandidate = Schemas['api.plexCandidate']

// SuggestionItem is one deduplicated suggestion (a single series regardless of
// how many providers surfaced it). category ∈ anime-movie|anime-tv|movie|tv.
export type SuggestionItem = Schemas['api.SugItem']

// SyncPlan is the pre-computed local target for a one-off sync of a suggestion:
// a series season into its Season folder under the show, a movie into its own
// subfolder. localPath empty = target unresolved (UI hides the button).
export type SyncPlan = Schemas['api.SyncPlan']

// DuplicateItem is content the library holds twice: the same season/movie in
// several folders, or one episode under two names in one folder.
export type DuplicateItem = Schemas['api.DuplicateItem']

export type DuplicateEpisode = Schemas['api.DuplicateEpisode']

export type DuplicateCopy = Schemas['api.DuplicateCopy']

export type SuggestionsResponse = Schemas['api.SuggestionsResponse']

export type UpgradeVariant = Schemas['api.UpgradeVariant']

// One episode as the metadata provider lists it, flagged with whether the
// watch's local folder holds it. season is the LOCAL one, i.e. what is on disk.
export type WatchEpisode = Schemas['api.WatchEpisode']

// episodes is never null: without a provider the numbers from the local file
// names still explain the gap badge, and reason says why the titles are gone.
export type WatchEpisodes = Schemas['api.WatchEpisodesResponse']

// One season - or the movie - of a show the library already holds. folder is a
// local directory, or a "plex:" key when the Plex path is not a shared mount.
export type LocalSeason = Schemas['api.LocalSeason']

export type UpgradeSuggestion = Schemas['api.UpgradeSuggestion']

export type UpgradeDims = Schemas['api.UpgradeDims']

export type DismissedItem = Schemas['api.DismissedItem']

// The one-time hints the user has closed, on any device.
export type Tips = Schemas['api.TipsResponse']

export type PlexAccount = Schemas['api.plexAccountResponse']

export type PlexLinkStart = Schemas['api.plexLinkResponse']

export type PlexWatchItem = Schemas['api.PlexWatchItem']

export type Review = Schemas['anilist.Review']

// The title card's secondary content, from GET /api/media/extras. Every list
// is present; a source that has no such thing sends it empty.
export type MediaExtras = Schemas['api.mediaExtrasResponse']
// A recommended title: the media record plus `rating`, the AniList vote count
// behind the recommendation (absent for TMDB).
export type RecommendedMedia = Schemas['api.recommendedMedia']

// the display title of a watch: the override, else the record's, else the folder
/** Which provider record a suggestion's `media` is: anime is AniList, the rest TMDB. */
/** One item waiting in a trash folder: a video with its sidecars, or a folder. */
export type TrashEntry = Schemas['api.TrashEntry']

export const suggestionSource = (s: { category: string; isMovie?: boolean }) =>
  s.category.startsWith('anime') ? 'anilist' : s.isMovie || s.category === 'movie' ? 'tmdb:movie' : 'tmdb:tv'

export const watchTitle = (w: Watch) => w.titleOverride || mediaTitle(w.media, w.remotePath.split('/').pop() || '')

export type SearchResult = Schemas['api.ServerSearchResponse']

export type RenamePair = Schemas['api.renamePair']

// KeyConflict is the 409 body a dial returns when the server's SSH host key
// is not trusted yet or has changed: the fingerprints to review and the key
// that "accept" pins.
export type KeyConflict = Schemas['api.HostKeyConflict']

// keyConflictOf reads a host key conflict off a failed request, null for any
// other failure.
export function keyConflictOf(e: unknown): KeyConflict | null {
  if (e instanceof ApiError && e.status === 409 && (e.data as KeyConflict | undefined)?.newKey)
    return e.data as KeyConflict
  return null
}

export class ApiError extends Error {
  status: number
  // parsed JSON error body, for endpoints that return more than {error}
  data?: unknown
  /** the server's own words, before translation: for code that tells errors apart */
  raw: string
  constructor(status: number, message: string, data?: unknown, raw = message) {
    super(message)
    this.status = status
    this.data = data
    this.raw = raw
  }
}

// The API answers in English for every client; the messages a person meets
// while signing in or managing accounts are shown in the UI language. Keyed by
// the server's exact words, so an unknown one passes through unchanged.
const ERROR_KEYS: Record<string, string> = {
  'invalid credentials': 'errors.invalidCredentials',
  'setup token required': 'errors.setupToken',
  'account awaits approval': 'errors.awaitingApproval',
  'account upgrade required': 'errors.upgradeRequired',
  'email not verified - check your inbox': 'errors.emailUnverified',
  'invalid code': 'errors.invalidCode',
  'invalid or expired login': 'errors.loginExpired',
  'expired login session': 'errors.loginExpired',
  'passkey login failed': 'errors.passkeyFailed',
  'this passkey must verify you with a PIN or biometrics': 'errors.passkeyNoUv',
  'security key verification failed': 'errors.passkeyFailed',
  'email already registered': 'errors.emailTaken',
  'invalid email': 'errors.invalidEmail',
  'registration is disabled': 'errors.registrationClosed',
  'password auth is disabled, use OIDC': 'errors.passwordDisabled',
  'password must be at least 10 characters': 'errors.weakPassword',
  'password is too common or easy to guess': 'errors.commonPassword',
  'current password is wrong': 'errors.wrongPassword',
  'invalid password': 'errors.wrongPassword',
  'this reset link is invalid or has expired': 'errors.resetLinkInvalid',
  'this account signs in through OIDC': 'errors.oidcAccount',
  'passkeys need an account with a password': 'errors.oidcAccount',
  'cannot delete the last admin': 'errors.lastAdminDelete',
  'cannot demote the last admin': 'errors.lastAdminDemote',
  'cannot delete yourself': 'errors.deleteSelf',
  'roles managed by OIDC': 'errors.rolesByOidc',
  'manual user creation is disabled in OIDC mode; users onboard via the identity provider': 'errors.noManualUsers',
}

// transport failures from the backend arrive as Go's raw error strings
// ("dial tcp 10.0.0.2:22: connect: connection refused"); say what happened
// in words, the raw line stays in ApiError.raw for whoever needs it
const NET_ERRORS: [RegExp, string][] = [
  [/connection refused/i, 'errors.net.refused'],
  [/i\/o timeout|deadline exceeded|timed out/i, 'errors.net.timeout'],
  [/no such host|server misbehaving/i, 'errors.net.noHost'],
  [/connection reset|broken pipe|unexpected EOF/i, 'errors.net.reset'],
  [/network is unreachable|no route to host/i, 'errors.net.unreachable'],
  [/unable to authenticate|permission denied \(publickey|login incorrect/i, 'errors.net.auth'],
  [/x509|tls: /i, 'errors.net.tls'],
]

/** a backend error string in words, or the string itself when it is not a known transport failure */
export function netErrorText(msg: string): string {
  for (const [re, key] of NET_ERRORS) if (re.test(msg)) return i18n.t(key)
  return msg
}

function errorText(res: Response, msg: string): string {
  if (res.status === 429) {
    const s = Number(res.headers.get('Retry-After'))
    return s > 0 ? i18n.t('errors.tooManyWait', { count: s }) : i18n.t('errors.tooMany')
  }
  const key = ERROR_KEYS[msg]
  return key ? i18n.t(key) : netErrorText(msg)
}

async function request<T>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const h: Record<string, string> = { ...headers }
  if (body !== undefined) h['Content-Type'] = 'application/json'
  const res = await fetch(url, {
    method,
    headers: Object.keys(h).length ? h : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    // HTTP/2 carries no reason phrase, so statusText is empty behind most proxies
    let msg = res.statusText || `HTTP ${res.status}`
    let data: unknown
    try {
      data = await res.json()
      const err = (data as { error?: string }).error
      if (err) msg = err
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, errorText(res, msg), data, msg)
  }
  // a 204 (or any empty body) is a success with nothing to read; res.json()
  // would throw "Unexpected end of JSON input" on it
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', url, body, headers),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string, body?: unknown) => request<T>('DELETE', url, body),
}

// ── assistant ──

export type AiStatus = Schemas['api.aiStatusResponse']

export type AiModels = Schemas['api.aiModelsResponse']

export type AiChatMessage = Schemas['api.aiChatMessage']

export type AiChatSummary = Schemas['api.aiChatSummary']

// AiProposal is a vetted action the assistant suggests; fields prefill the
// watch dialog, the user confirms there.
export interface AiProposal {
  kind: 'watch' | 'sync' | 'upgrade'
  title: string
  serverId: number
  serverName: string
  remotePath: string
  fields: {
    localPath: string
    template: string
    subfolder: boolean
    subfolderSource?: SubfolderMode
    subfolderSeparator?: string
    seasonFolder?: string
    replaceOld?: boolean
  } & Record<string, unknown>
  info?: string[]
  unverified?: boolean
}

// AiCard is one recommended title: the provider record the catalog's detail
// view renders, plus the assistant's one-line reason.
export interface AiCard {
  source: string
  media: Media
  why?: string
}

export type AiEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; name: string; params?: Record<string, unknown> }
  | { type: 'tool_done'; name: string; stats?: Record<string, unknown> }
  | ({ type: 'proposal' } & AiProposal)
  | { type: 'cards'; cards: AiCard[] }
  // titles the answer names, with their records: the client links the names
  | { type: 'links'; cards: AiCard[] }
  | { type: 'upgrades'; upgrades: UpgradeSuggestion[] }
  // a follow-up the running answer took on: the client mirrors it as a
  // user turn and the answer continues in a new bubble after it
  | { type: 'steer'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

// parseSseChunk consumes one network chunk of an SSE body. Lines may be cut
// anywhere, so the unfinished tail comes back as `rest` for the next call.
export function parseSseChunk(buffer: string, chunk: string): { events: AiEvent[]; rest: string } {
  const text = buffer + chunk
  const lines = text.split('\n')
  const rest = lines.pop() ?? ''
  const events: AiEvent[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith('data:')) continue
    try {
      events.push(JSON.parse(line.slice(5).trim()) as AiEvent)
    } catch {
      /* keepalive or a torn frame: skip */
    }
  }
  return { events, rest }
}

// streamAiChat posts the conversation and feeds every event to onEvent as it
// arrives. EventSource cannot POST, hence fetch + a reader.
export async function streamAiChat(
  messages: AiChatMessage[],
  onEvent: (ev: AiEvent) => void,
  signal?: AbortSignal,
  model?: string,
  opts: { tools?: string[]; mode?: 'research' } = {},
) {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      model: model || undefined,
      tools: opts.tools?.length ? opts.tools : undefined,
      mode: opts.mode,
    }),
    signal,
  })
  if (!res.ok || !res.body) {
    let msg = res.statusText
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const parsed = parseSseChunk(buffer, decoder.decode(value, { stream: true }))
    buffer = parsed.rest
    parsed.events.forEach(onEvent)
  }
  parseSseChunk(buffer, '\n').events.forEach(onEvent)
}

// syncOutcome turns a sync result into one sentence. Empty when files were
// queued: then the queue itself is the answer. Otherwise it names the reason,
// because "0 queued" alone reads like a failure.
export function syncOutcome(r: SyncResult, t: (k: string, o?: Record<string, unknown>) => string): string {
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

// langLabel names what a watch's language filter asks for: "Ger-Dub",
// "Ger-Sub" or both joined, '' when the filter is off.
export function langLabel(w: Pick<Watch, 'wantDub' | 'wantSub'>): string {
  return [w.wantDub && `${w.wantDub}-Dub`, w.wantSub && `${w.wantSub}-Sub`].filter(Boolean).join('/')
}

// One episode with its season.
export type EpRef = Schemas['api.EpRef']

const pad2 = (n: number) => String(n).padStart(2, '0')

// epLabel names an episode of a watch: with its season once the folder holds
// more than one (the latest when none is given - that is where new episodes
// land), the bare number otherwise, where the season chip says which. The
// original absolute number follows in parens under a renumber offset.
export function epLabel(w: Pick<Watch, 'seasons' | 'offset'>, e: number, s?: number): string {
  const seasons = w.seasons ?? []
  const abs = w.offset ? ` (${e - w.offset})` : ''
  if (seasons.length > 1) return `S${pad2(s ?? seasons[seasons.length - 1])}E${pad2(e)}${abs}`
  return `${e}${abs}`
}

// fmtEps renders up to five episodes of a watch (see epLabel).
export function fmtEps(w: Pick<Watch, 'seasons' | 'offset'>, eps: EpRef[]): string {
  return eps
    .slice(0, 5)
    .map((r) => epLabel(w, r.e, r.s))
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
  // the decimal mark follows the UI language like every other number ("1,8
  // MiB" in German); no grouping, so "1023 KiB" never reads as 1.023
  const digits = v >= 100 ? 0 : 1
  const num = v.toLocaleString(i18n.language || 'en', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  })
  return `${num} ${units[u]}`
}

export function fmtSpeed(bps: number): string {
  return `${fmtBytes(bps)}/s`
}
