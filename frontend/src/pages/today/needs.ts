import { downloadLabel, netErrorText, type Download, type DownloadMeta, type ScopeHint, type Watch } from '../../api'
import { attentionInfo } from '../../attention'
import { isFsErrorCode } from '../../components/FsErrorNote'

type T = (key: string, opts?: Record<string, unknown>) => string

// What needs a hand on the Today page, as one list of rows: failed
// downloads, auto-syncs that wait on something, new folders that look like
// marked ones. Each row says what, why in one line, and offers one action.

export type NeedKind = 'failed' | 'watch' | 'hint' | 'plex' | 'ftp'

export interface Need {
  /** stable per thing: the row's React key and its place in the list */
  key: string
  /**
   * the thing and its reason: a row hidden by the user stays hidden while
   * this holds, and comes back when the reason changes
   */
  print: string
  kind: NeedKind
  /** err for failures, accent-2 for rows that explain ("Warum?"), accent else */
  tone: 'accent' | 'accent-2' | 'err'
  title: string
  sub: string
  /** the action's label */
  act: string
  /** the action explains rather than changes: the row stays after it */
  why: boolean
  /** a single failed download */
  download?: Download
  /** two or more failed downloads with the same cause on the same server */
  group?: Download[]
  /** the server a failed row ran into, for "Check server" */
  serverId?: number
  /** the backend's own words for a failure, when `sub` says it in ours */
  raw?: string
  /** the cause is the login: fixing it comes before trying again */
  auth?: boolean
  watch?: Watch
  hint?: ScopeHint
}

/** key and fingerprint prefix of the plain-FTP rows, which are only ever hidden for the session */
const FTP_PREFIX = 'ftp-'

/** how far back a failed download still asks for a hand */
export const FAILED_DAYS = 7

const ended = (d: Download) => (d.finishedAt ? Date.parse(d.finishedAt.replace(' ', 'T') + 'Z') : 0)

export function buildNeeds(
  t: T,
  {
    downloads,
    meta,
    watches,
    hints,
    now,
    plexToken,
    mediaChoose,
    serverNames,
    ftpServers,
  }: {
    downloads: Download[]
    meta?: DownloadMeta
    watches: Watch[]
    hints: ScopeHint[]
    now: number
    /** an admin's Plex runs on a pasted token: ask to sign in with Plex */
    plexToken?: boolean
    /** Plex and Jellyfin both connected, neither chosen: nothing runs */
    mediaChoose?: boolean
    /** server names by id, for the failures' "<server>: <cause>" line */
    serverNames?: Record<number, string>
    /** servers still on the retired plain FTP: nothing works for them until they move to FTPS */
    ftpServers?: { id: number; name: string }[]
  },
): Need[] {
  const out: Need[] = []
  // first: such a server cannot connect at all, so its transfers fail too
  for (const sv of ftpServers ?? []) {
    out.push({
      key: `${FTP_PREFIX}${sv.id}`,
      print: `${FTP_PREFIX}${sv.id}`,
      kind: 'ftp',
      tone: 'err',
      title: t('today.needFtp', { name: sv.name }),
      sub: t('today.needFtpSub'),
      act: t('today.needFtpAct'),
      why: false,
      serverId: sv.id,
    })
  }
  if (mediaChoose) {
    out.push({
      key: 'media-choose',
      print: 'media-choose',
      kind: 'plex',
      tone: 'accent',
      title: t('today.needMediaServer'),
      sub: t('today.needMediaServerSub'),
      act: t('today.needMediaServerAct'),
      why: false,
    })
  }
  if (plexToken) {
    out.push({
      key: 'plex-token',
      print: 'plex-token',
      kind: 'plex',
      tone: 'accent',
      title: t('today.needPlex'),
      sub: t('today.needPlexSub'),
      act: t('settings.plexSignIn'),
      why: false,
    })
  }
  // failures with the same cause on the same server are one row: fifteen
  // rejected logins are one problem, not fifteen
  const failed = new Map<string, Download[]>()
  for (const d of downloads) {
    if (d.status !== 'error') continue
    const at = ended(d)
    if (at && now - at > FAILED_DAYS * 86_400_000) continue
    const k = failureKey(d)
    failed.set(k, [...(failed.get(k) ?? []), d])
  }
  for (const [k, list] of failed) {
    const d = list[0]
    const server = serverNames?.[d.serverId]
    const reason = failureText(t, d)
    const raw = d.error && d.error !== reason ? d.error : undefined
    const auth = d.errorCode === 'auth_failed'
    if (list.length > 1) {
      out.push({
        key: `grp-${k}`,
        print: `grp-${k}-${list.map((x) => `${x.id}.${x.attempts ?? 0}`).join(',')}`,
        kind: 'failed',
        tone: 'err',
        title: t('today.needFailedMany', { count: list.length }),
        sub: server ? `${server}: ${reason}` : reason,
        act: auth ? t('today.checkServer') : t('today.retryAll'),
        why: false,
        group: list,
        serverId: d.serverId,
        raw,
        auth,
      })
      continue
    }
    const { group, name, ep } = downloadLabel(d, meta)
    const what = group?.title ? [group.title, ep].filter(Boolean).join(' ') : name
    out.push({
      key: `dl-${d.id}`,
      print: `dl-${d.id}-${d.errorCode ?? ''}-${d.attempts ?? 0}`,
      kind: 'failed',
      tone: 'err',
      title: t('today.needFailed', { what }),
      sub: reason,
      act: auth ? t('today.checkServer') : t('dash.retry'),
      why: false,
      download: d,
      serverId: d.serverId,
      raw,
      auth,
    })
  }
  for (const w of watches) {
    const chips = attentionInfo(t, w)
    if (!chips.length) continue
    const title =
      w.titleOverride || w.media?.title?.preferred || w.media?.title?.romaji || w.remotePath.split('/').pop() || ''
    out.push({
      key: `w-${w.id}`,
      print: `w-${w.id}-${(w.attention ?? []).join(',')}`,
      kind: 'watch',
      tone: 'accent-2',
      title,
      sub: chips.map((c) => c.text).join(' · '),
      act: t('explain.why'),
      why: true,
      watch: w,
    })
  }
  for (const h of hints) {
    out.push({
      key: `h-${h.serverId}-${h.path}`,
      print: `h-${h.serverId}-${h.path}-${h.kind}`,
      kind: 'hint',
      tone: 'accent',
      title: t('today.needFolder', { name: h.name }),
      sub: t('dash.folderHintWhy', { server: h.serverName, sibling: h.sibling, kind: scopeKindLabel(t, h.kind) }),
      act: t('today.needMark'),
      why: false,
      hint: h,
    })
  }
  return out
}

/** What a failed download says about itself, in words: the classified cause, else the backend's text made readable. */
function failureText(t: T, d: Download): string {
  if (d.errorCode === 'auth_failed') return t('today.needAuth')
  if (isFsErrorCode(d.errorCode)) return t(`fsError.${d.errorCode}.what`, { path: dirOf(d) })
  return d.error ? netErrorText(d.error) : t('today.needFailedSub')
}

const dirOf = (d: Download) => d.localPath.slice(0, d.localPath.lastIndexOf('/')) || '/'

/**
 * The cause two failures share: server plus the error code, or, when the
 * backend did not classify it, its text with the numbers (ports, sizes,
 * addresses) taken out. A filesystem cause is per directory.
 */
export function failureKey(d: Download): string {
  const cause = d.errorCode
    ? isFsErrorCode(d.errorCode)
      ? `${d.errorCode}:${dirOf(d)}`
      : d.errorCode
    : netErrorText(d.error ?? '')
        .replace(/\d+/g, '#')
        .slice(0, 120)
  return `${d.serverId}-${cause}`
}

/** Where "+N more" leads: the failed downloads when that is what is hidden, else the auto-syncs. */
export function moreLink(hidden: Need[]): string {
  return hidden.length > 0 && hidden.every((n) => n.kind === 'failed')
    ? '/history?filter=fail'
    : '/watches?filter=attention'
}

/** A folder mark's kind in words ("Anime", "Serie"). */
export function scopeKindLabel(t: T, kind: string): string {
  const keys: Record<string, string> = {
    anime: 'remote.scopeAnime',
    manga: 'remote.scopeManga',
    tv: 'remote.scopeTv',
    movie: 'remote.scopeMovie',
    tvdb: 'remote.scopeTvdb',
  }
  return keys[kind] ? t(keys[kind]) : kind
}

const HIDDEN_KEY = 'weebsync.today.hidden'

/** The rows the user swiped away on this browser, by fingerprint. */
export function hiddenNeeds(): Set<string> {
  const out = new Set<string>()
  for (const [store, key] of [
    [localStorage, HIDDEN_KEY],
    [sessionStorage, HIDDEN_KEY],
  ] as const) {
    try {
      for (const p of JSON.parse(store.getItem(key) ?? '[]') as string[]) out.add(p)
    } catch {
      /* unreadable or blocked: nothing hidden from this store */
    }
  }
  return out
}

/** Hides a row until the tab closes: for rows whose condition holds until it is fixed. */
export function hideForSession(print: string) {
  try {
    const now = new Set(JSON.parse(sessionStorage.getItem(HIDDEN_KEY) ?? '[]') as string[])
    sessionStorage.setItem(HIDDEN_KEY, JSON.stringify([...now.add(print)]))
  } catch {
    /* storage blocked: the row comes back on the next render */
  }
}

/** Whether a row may only be hidden for the session. */
export const sessionOnly = (n: Need) => n.kind === 'ftp'

/** Keeps the hidden set to the rows that still exist, so it never grows without end. */
export function saveHidden(hidden: Set<string>, live: Need[]) {
  const keep = live
    .filter((n) => !sessionOnly(n))
    .map((n) => n.print)
    .filter((p) => hidden.has(p))
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(keep))
  } catch {
    /* storage blocked: hidden for this visit only */
  }
}
