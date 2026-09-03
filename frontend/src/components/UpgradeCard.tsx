import { ArrowRight, Clapperboard, Download, ExternalLink, EyeOff, FolderOpen, Info, ListVideo, Tv } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, ButtonLink, Cover, Panel, Radio } from '@weebsync/design-system'
import type { LocalSeason, UpgradeDims, UpgradeSuggestion, UpgradeVariant } from '../api'
import Collapsible from './Collapsible'
import { ProviderBadges } from './ProviderBadges'
import type { WatchFields } from './WatchDialog'
import {
  axesWon,
  fmtRes,
  groupByFolder,
  langGain,
  sameSource,
  sourceLabel,
  splitFolder,
  syncFields,
  variantDiff,
  variantQuality,
} from './upgradeQuality'

// SyncRequest is what the card hands up when the user wants the chosen copy:
// the WatchDialog's initial form plus the context lines it shows.
export interface SyncRequest {
  serverId: number
  name: string
  initial: WatchFields
  info: string[]
}

// VariantBox shows one copy: where it lives (Local (Plex) when the server name
// is empty, else the server name) plus its full path, its quality make-up, and
// how that make-up was established - measured from the file, or read off its
// name. That last line is what makes a disputed recommendation readable from
// the card instead of from the log.
function VariantBox({ v, label, muted, accent }: { v: UpgradeVariant; label: string; muted?: boolean; accent?: boolean }) {
  const { t } = useTranslation()
  const { dir, name } = splitFolder(v.folder)
  return (
    // both copies sit on their own recessed surface, so the pair reads as two
    // objects being compared instead of two paragraphs sharing the card
    <div
      className={`min-w-0 border bg-bg-secondary p-2 ${accent ? 'border-accent' : 'border-border-subtle'} ${muted ? 'text-t-muted' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={accent ? 'accent' : 'neutral'} className="shrink-0">
          {label}
        </Badge>
        <Badge className="shrink-0">{v.serverName ? v.serverName : t('suggestions.localPlex')}</Badge>
      </div>
      <div className="mt-1 wrap-break-word font-mono text-xs" title={v.folder}>
        {name}
      </div>
      {dir && (
        <div className="truncate font-mono text-xs text-t-muted" title={v.folder}>
          {dir}
        </div>
      )}
      <div className="mt-1 text-xs">{variantQuality(v, t)}</div>
      <div className="text-xs text-t-muted">{t('suggestions.basisQuality', { how: sourceLabel(v, t) })}</div>
    </div>
  )
}

// LocalSeasons lists what the library already holds of this show, so the card
// answers "and which seasons do I have?" without a trip to Plex. The season of
// this very suggestion is marked, because that is the one a sync would touch.
// File names live in the sync dialog's preview, where they carry the
// new/replaced marks; repeating them here would only bloat the card.
function LocalSeasons({ seasons, current, isMovie }: { seasons: LocalSeason[]; current: number; isMovie?: boolean }) {
  const { t } = useTranslation()
  return (
    <Collapsible small defaultOpen={false} title={t('suggestions.localSeasons')} count={seasons.length}>
      <ul className="space-y-1">
        {seasons.map((ls) => {
          const here = !isMovie && !ls.isMovie && ls.season === current
          // a "plex:ratingKey:sN" folder means the copy is not on a mount we
          // share, so there is no path to show - only the season and quality
          const path = ls.folder.startsWith('/') ? ls.folder : ''
          return (
            <li key={`${ls.season}-${ls.folder}`} className="flex flex-wrap items-center gap-2 text-xs">
              <Badge tone={here ? 'accent' : 'neutral'} className="shrink-0">
                {ls.isMovie
                  ? t('suggestions.movie')
                  : ls.season === 0
                    ? t('suggestions.specials') // season 0 is what Plex calls Specials
                    : t('suggestions.season', { season: ls.season })}
              </Badge>
              <span className="min-w-0 flex-1 break-all font-mono text-t-secondary" title={path}>
                {path}
              </span>
              <span className="shrink-0 text-t-muted">{fmtRes(ls.resRank)}</span>
            </li>
          )
        })}
      </ul>
    </Collapsible>
  )
}

// UpgradeCard is one upgrade suggestion: the local copy against the chosen
// remote one, every other remote copy to pick from, the seasons the library
// already holds, and the actions. Shared by the Suggestions page and the
// assistant, which is why choosing and syncing are handed up as callbacks.
export default function UpgradeCard({
  u,
  dims,
  chosen,
  onChoose,
  onSync,
  onDismiss,
  onOpenRemote,
  onDetails,
}: {
  u: UpgradeSuggestion
  dims: UpgradeDims | undefined
  chosen: UpgradeVariant
  onChoose: (v: UpgradeVariant) => void
  onSync: (req: SyncRequest) => void
  onDismiss?: (u: UpgradeSuggestion) => void
  onOpenRemote?: (v: UpgradeVariant) => void
  onDetails?: (u: UpgradeSuggestion) => void
}) {
  const { t } = useTranslation()
const seasonLabel = u.isMovie ? t('suggestions.movie') : u.season > 0 ? t('suggestions.season', { season: u.season }) : ''
const isChosen = (v: UpgradeVariant) => v.serverId === chosen.serverId && v.folder === chosen.folder
const options: UpgradeVariant[] = u.options ?? []
// a language gain the two copies cannot settle between them: shown,
// and shown as unconfirmed. Recomputed rather than read off
// u.languageUnverified, because the user may have picked another
// option than the recommended one.
const langUnconfirmed = !sameSource(u.from, chosen) && langGain(u.from, chosen, dims)
const syncInfo = [
  t('watch.infoSource', { server: chosen.serverName || t('suggestions.localPlex'), quality: variantQuality(chosen, t) }),
  t('watch.infoLocal', { quality: variantQuality(u.from, t) }),
]
return (
  // handwritten instead of SuggestionCard: the heading row pairs the
  // title with the right-aligned diff chips, which the card's plain
  // <h4> slot cannot hold
  <Panel className="flex flex-wrap items-start gap-4 p-3">
    <Cover src={u.cover} />
    <div className="min-w-0 flex-1">
      {/* the diff chips stay beside the title instead of being pushed
          to the far edge of a wide card, where they end up an arm's
          length from what they describe */}
      <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-3">
        <h4 className="min-w-0 wrap-break-word font-display text-sm font-semibold tracking-wider">{u.title}</h4>
        <div className="flex flex-wrap gap-1">
          {variantDiff(u.from, chosen, dims, t).map((d, j) => (
            <Badge key={j} tone="accent">
              {d}
            </Badge>
          ))}
          {langUnconfirmed && <Badge tone="warn">{t('suggestions.langUnverified')}</Badge>}
        </div>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
        {seasonLabel && <Badge tone="accent">{seasonLabel}</Badge>}
        <ProviderBadges providers={u.providers ?? []} links={u.links ?? {}} />
        {u.format && (
          <Badge>
            {u.format === 'MOVIE' ? <Clapperboard aria-hidden size="1em" /> : <Tv aria-hidden size="1em" />}
            {u.format === 'MOVIE' ? t('suggestions.movie') : t('suggestions.show')}
          </Badge>
        )}
        {u.episodes ? (
          <span className="inline-flex items-center gap-1 pl-1 text-t-muted">
            <ListVideo aria-hidden size="1em" />
            {t('suggestions.episodes', { count: u.episodes })}
          </span>
        ) : null}
        {u.library && <Badge aria-label={t('suggestions.library', { name: u.library })}>{u.library}</Badge>}
      </p>
      <div className="mt-2 grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
        <VariantBox v={u.from} label={t('suggestions.fromLabel')} muted />
        {/* points down while the boxes are stacked, right once they sit
            side by side; decorative either way, the labels say it */}
        <ArrowRight aria-hidden size="1em" className="mx-auto rotate-90 text-t-muted sm:rotate-0" />
        <VariantBox
          v={chosen}
          label={isChosen(u.to) ? t('suggestions.recommended') : t('suggestions.chosenVersion')}
          accent
        />
      </div>
      <p className="mt-2 text-xs text-t-secondary">
        {t('suggestions.basis', { axes: axesWon(u.from, chosen, dims, t) })}
        {langUnconfirmed && ` ${t('suggestions.basisLangUnverified')}`}
      </p>
      {options.length > 0 && (
        // a show can have a dozen copies scattered over the servers;
        // unfolded they bury the card's actual answer, so the list
        // stays behind its own heading unless it is short. The visible
        // name is that heading - the legend only repeats it for the
        // screen reader, which never sees it.
        <div className="mt-2 min-w-0">
          <Collapsible
            small
            defaultOpen={options.length <= 4}
            title={t('suggestions.chooseVersion')}
            count={options.length}
          >
            <fieldset className="min-w-0 border-0 p-0">
              <legend className="sr-only">{t('suggestions.chooseVersion')}</legend>
              <ul className="min-w-0 space-y-3">
                {groupByFolder(options).map((g) => (
                  <li key={`${g.server}-${g.dir}`} className="min-w-0">
                    {/* the directory and the server, said once for
                        the whole group */}
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge className="shrink-0">{g.server ? g.server : t('suggestions.localPlex')}</Badge>
                      <span className="min-w-0 truncate font-mono text-xs text-t-muted" title={g.dir}>
                        {g.dir || '/'}
                      </span>
                    </p>
                    <ul className="mt-1 min-w-0 space-y-1">
                      {g.items.map((o, j) => {
                        const diff = variantDiff(u.from, o, dims, t)
                        const { name } = splitFolder(o.folder)
                        return (
                          <li key={`${o.serverId}-${o.folder}-${j}`} className="min-w-0">
                            {/* one row: what tells this copy apart from
                                its neighbours, and what it is made of.
                                Everything sits left of the same edge,
                                so no line has to be followed across the
                                width of the card to be read, and every
                                row carries its own surface so a dozen
                                of them do not run together into one
                                block. */}
                            <label
                              className={`grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 border p-2 ${
                                isChosen(o)
                                  ? 'border-accent bg-bg-hover'
                                  : // hover only lifts the surface: an
                                    // accent border on hover would look
                                    // exactly like the chosen row
                                    'border-border-subtle bg-bg-secondary hover:bg-bg-hover'
                              }`}
                            >
                              <Radio
                                name={`opt-${u.key}`}
                                checked={isChosen(o)}
                                onChange={() => onChoose(o)}
                              />
                              <span className="min-w-0">
                                <span
                                  className="block font-mono text-xs wrap-break-word text-t-primary"
                                  title={o.folder}
                                >
                                  {name}
                                </span>
                                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-t-muted">
                                  <span>{variantQuality(o, t)}</span>
                                  {diff.map((d, k) => (
                                    <Badge key={k} tone="accent">
                                      {d}
                                    </Badge>
                                  ))}
                                </span>
                              </span>
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            </fieldset>
          </Collapsible>
        </div>
      )}
      {(u.localSeasons ?? []).length > 0 && (
        <div className="mt-2">
          <LocalSeasons seasons={u.localSeasons!} current={u.season} isMovie={u.isMovie} />
        </div>
      )}
      <div className="mt-2 flex flex-wrap justify-end gap-1.5">
        {u.sync?.localPath && (
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              onSync({ serverId: chosen.serverId, name: u.title, initial: syncFields(u.sync!, u.title, chosen.folder), info: syncInfo })
            }
          >
            <Download aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('plex.syncOnce')}
          </Button>
        )}
        {u.links?.plex && (
          <ButtonLink size="sm" href={u.links.plex} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('suggestions.openPlex')}
          </ButtonLink>
        )}
        {u.media && onDetails && (
          <Button size="sm" onClick={() => onDetails(u)} aria-label={t('remote.detailsFor', { name: u.title })}>
            <Info aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('remote.details')}
          </Button>
        )}
        {onDismiss && (
          <Button size="sm" onClick={() => onDismiss(u)}>
            <EyeOff aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('suggestions.dismiss')}
          </Button>
        )}
        {onOpenRemote && (
          <Button size="sm" onClick={() => onOpenRemote(chosen)}>
            <FolderOpen aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('plex.openBrowser')}
          </Button>
        )}
      </div>
    </div>
      {u.why && <p className="mt-1 text-[11px] text-t-secondary">{u.why}</p>}
  </Panel>
)
}
