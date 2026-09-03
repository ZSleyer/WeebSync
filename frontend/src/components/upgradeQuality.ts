import type { SyncPlan, UpgradeDims, UpgradeVariant } from '../api'
import type { WatchFields } from './WatchDialog'

// guessSeason reads a trailing season number from a title for the sync template.
export function guessSeason(title: string): number {
  const m = title.match(/\b(?:season|s)\s*(\d{1,2})\b/i) || title.match(/\s(\d{1,2})$/)
  const n = m ? parseInt(m[1], 10) : 0
  return n >= 2 ? n : 0
}

// syncFields builds the one-off sync form from a suggestion's pre-computed
// SyncPlan (correct season/movie target + rename template) and the chosen remote
// source. Fed to WatchDialog; its dry-run preview shows the resulting path.
export function syncFields(sync: SyncPlan, title: string, remotePath: string): WatchFields {
  return {
    remotePath,
    localPath: sync.localPath,
    mode: 'template',
    template: sync.template ?? '',
    separator: '',
    titleOverride: title,
    pattern: '',
    replacement: '',
    subfolder: sync.subfolder,
    mediaId: 0,
    mediaSource: 'anilist',
    fromEpisode: 0,
    airedMapping: false,
    renameProvider: '',
    renameOrdering: '',
    renameTitleLang: '',
    renameSeriesId: 0,
    wantDub: '',
    wantSub: '',
    plexAudioLang: '',
    plexSubLang: '',
  }
}

export function fmtRes(r: number): string {
  if (!r) return '?'
  if (r >= 2160) return '4K'
  return `${r}p`
}

// resTier mirrors the backend's resTier: a measured height folds onto the rung
// it belongs to, so a padded 1088 (mod-16 1080p) is not shown as beaten by the
// round 1080 a file name states. Keep the two in step.
export function resTier(h: number): number {
  if (h <= 0) return 0
  if (h < 600) return 480
  if (h < 900) return 720
  if (h < 1300) return 1080
  if (h < 1800) return 1440
  if (h < 3000) return 2160
  return 4320
}

// "Und" is the backend's marker for a track whose language could not be read.
// It is a recorded hole, not a language, so it is never shown as one.
export const UNREADABLE = 'Und'
export const realLangs = (xs: string[]) => (xs ?? []).filter((x) => x !== UNREADABLE)

export const addedLangs = (a: string[], b: string[]) => realLangs(b).filter((x) => !(a ?? []).includes(x))

// measured: were this copy's tracks actually read? probed 0 means nobody has
// opened the file yet, so everything it says about its languages comes from its
// name. The backend refuses to call that an upgrade, and neither may the card -
// it decides which badges a card shows entirely on its own, so without this the
// gain reappears here after being dropped there.
export const measured = (v: UpgradeVariant) => v.probed !== 0

// sameSource: were both copies' qualities established the same way? A measured
// copy against a name-parsed one cannot settle a language difference between
// them - the name may promise a track the container does not carry. The backend
// only lets such a gain through when the container refused to be read at all, in
// which case the gain is shown as unconfirmed.
export const sameSource = (a: UpgradeVariant, b: UpgradeVariant) => a.probed === b.probed

// langGain: does v add a sub or dub language on an axis the user asked for?
export const langGain = (from: UpgradeVariant, v: UpgradeVariant, dims: UpgradeDims | undefined) =>
  measured(v) &&
  (((dims?.sub ?? true) && addedLangs(from.sub, v.sub).length > 0) ||
    ((dims?.dub ?? true) && addedLangs(from.dub, v.dub).length > 0))

// burnedIn: languages this copy advertises but cannot hand over as a track.
export const burnedIn = (v: UpgradeVariant) => realLangs(v.sub).filter((x) => !(v.soft ?? []).includes(x))

// softGain: does v offer as a real track what the local copy only burns into
// the picture?
export const softGain = (from: UpgradeVariant, v: UpgradeVariant) => addedLangs(from.soft, v.soft).length > 0

// variantDiff spells out what v would improve over the local copy on the
// user's enabled axes: resolution step and added dub/sub languages. Empty
// means this copy is no improvement.
export function variantDiff(
  from: UpgradeVariant,
  v: UpgradeVariant,
  dims: UpgradeDims | undefined,
  t: (k: string, o?: Record<string, unknown>) => string,
): string[] {
  const out: string[] = []
  if ((dims?.res ?? true) && resTier(v.resRank) > resTier(from.resRank)) {
    out.push(`${fmtRes(from.resRank)} → ${fmtRes(v.resRank)}`)
  }
  if (!measured(v)) {
    // nothing was read from this file, so it has nothing to say about its
    // languages yet. The probe loop takes it next; until then the card offers
    // only what a name and a container height can honestly establish.
    if (out.length === 0) out.push(t('suggestions.upLangPending'))
    return out
  }
  if (dims?.dub ?? true) {
    const d = addedLangs(from.dub, v.dub)
    if (d.length) out.push(`${t('suggestions.upDub')} +${d.join(',')}`)
  }
  if (dims?.sub ?? true) {
    const s = addedLangs(from.sub, v.sub)
    if (s.length) out.push(`${t('suggestions.upSub')} +${s.join(',')}`)
  }
  if (dims?.soft ?? true) {
    const s = addedLangs(from.soft, v.soft)
    if (s.length) out.push(`${t('suggestions.upSoft')} ${s.join(',')}`)
  }
  return out
}

// sourceLabel names how one copy's quality was established, for the card.
export function sourceLabel(v: UpgradeVariant, t: (k: string) => string): string {
  if (v.probed === 1) return t('suggestions.basisMeasured')
  if (v.probed === 2) return t('suggestions.basisUnreadable')
  return t('suggestions.basisGuessed')
}

// axesWon lists the axes on which v actually beats the local copy, by the same
// rules the backend applied. Empty when the user picked an option that is no
// improvement at all.
export function axesWon(
  from: UpgradeVariant,
  v: UpgradeVariant,
  dims: UpgradeDims | undefined,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  const out: string[] = []
  if ((dims?.res ?? true) && resTier(v.resRank) > resTier(from.resRank)) out.push(t('suggestions.axis_res'))
  if (measured(v)) {
    if ((dims?.sub ?? true) && addedLangs(from.sub, v.sub).length) out.push(t('suggestions.axis_sub'))
    if ((dims?.dub ?? true) && addedLangs(from.dub, v.dub).length) out.push(t('suggestions.axis_dub'))
    if ((dims?.soft ?? true) && softGain(from, v)) out.push(t('suggestions.axis_soft'))
  }
  return out.length ? out.join(', ') : t('suggestions.basisNoAxis')
}

// variantQuality renders a copy's make-up: resolution, its dub/sub codes, and
// which of the subtitle languages are burned into the picture rather than
// offered as a track. "Und" never appears - it marks a track whose language
// could not be read, which is a hole in the account and not a language.
export function variantQuality(v: UpgradeVariant, t: (k: string) => string): string {
  const parts = [fmtRes(v.resRank)]
  const dub = realLangs(v.dub)
  const sub = realLangs(v.sub)
  const hard = burnedIn(v)
  if (dub.length) parts.push(`Dub ${dub.join(',')}`)
  if (sub.length) {
    const shown = sub.map((c) => (hard.includes(c) ? `${c} (${t('suggestions.subBurned')})` : c))
    parts.push(`Sub ${shown.join(',')}`)
  }
  return parts.join(' · ')
}

// splitFolder separates the release folder from the directory holding it. The
// copies of one show sit under the same few directories, so the tail is what
// actually tells them apart - it leads the line, the shared prefix follows in
// muted small print instead of pushing it off screen.
export function splitFolder(p: string): { dir: string; name: string } {
  const s = p.replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  return i > 0 ? { dir: s.slice(0, i), name: s.slice(i + 1) } : { dir: '', name: s || p }
}

// groupByFolder collects the copies that live in the same directory of the same
// server. The directory and the server are then said once above the group
// instead of on every row, which is what turns a dozen near-identical lines
// into a handful of short ones.
export function groupByFolder(options: UpgradeVariant[]): { server: string; dir: string; items: UpgradeVariant[] }[] {
  const out: { server: string; dir: string; items: UpgradeVariant[] }[] = []
  const seen = new Map<string, { server: string; dir: string; items: UpgradeVariant[] }>()
  for (const o of options) {
    const { dir } = splitFolder(o.folder)
    const key = `${o.serverId} ${dir}`
    let g = seen.get(key)
    if (!g) {
      g = { server: o.serverName ?? '', dir, items: [] }
      seen.set(key, g)
      out.push(g)
    }
    g.items.push(o)
  }
  return out
}

// fmtEpisodeRanges folds a sorted list of episode numbers into "E4, E6-E8".
export function fmtEpisodeRanges(nums: number[]): string {
  const out: string[] = []
  let i = 0
  while (i < nums.length) {
    let j = i
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++
    out.push(j > i + 1 ? `E${nums[i]}-E${nums[j]}` : j === i + 1 ? `E${nums[i]}, E${nums[j]}` : `E${nums[i]}`)
    i = j + 1
  }
  return out.join(', ')
}
