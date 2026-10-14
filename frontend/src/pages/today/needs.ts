import { downloadLabel, type Download, type DownloadMeta, type ScopeHint, type Watch } from '../../api'
import { attentionInfo } from '../../attention'
import { isFsErrorCode } from '../../components/FsErrorNote'

type T = (key: string, opts?: Record<string, unknown>) => string

// What needs a hand on the Today page, as one list of rows: failed
// downloads, auto-syncs that wait on something, new folders that look like
// marked ones. Each row says what, why in one line, and offers one action.

export type NeedKind = 'failed' | 'watch' | 'hint'

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
  download?: Download
  watch?: Watch
  hint?: ScopeHint
}

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
  }: { downloads: Download[]; meta?: DownloadMeta; watches: Watch[]; hints: ScopeHint[]; now: number },
): Need[] {
  const out: Need[] = []
  for (const d of downloads) {
    if (d.status !== 'error') continue
    const at = ended(d)
    if (at && now - at > FAILED_DAYS * 86_400_000) continue
    const { group, name, ep } = downloadLabel(d, meta)
    const what = group?.title ? [group.title, ep].filter(Boolean).join(' ') : name
    const dir = d.localPath.slice(0, d.localPath.lastIndexOf('/')) || '/'
    out.push({
      key: `dl-${d.id}`,
      print: `dl-${d.id}-${d.errorCode ?? ''}-${d.attempts ?? 0}`,
      kind: 'failed',
      tone: 'err',
      title: t('today.needFailed', { what }),
      sub: isFsErrorCode(d.errorCode)
        ? t(`fsError.${d.errorCode}.what`, { path: dir })
        : d.error || t('today.needFailedSub'),
      act: t('dash.retry'),
      why: false,
      download: d,
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
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

/** Keeps the hidden set to the rows that still exist, so it never grows without end. */
export function saveHidden(hidden: Set<string>, live: Need[]) {
  const keep = live.map((n) => n.print).filter((p) => hidden.has(p))
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(keep))
  } catch {
    /* storage blocked: hidden for this visit only */
  }
}
