import { useState } from 'react'
import { Link } from 'react-router'
import { useAuth, useMediaServer } from '../hooks'
import { useTranslation } from 'react-i18next'
import { Button, Checkbox, Radio, TextLink } from 'fluid-lycoris'
import type { LocalSeason, UpgradeDims, UpgradeSuggestion, UpgradeVariant } from '../api'
import type { WatchFields } from './WatchDialog'
import ActionMenu from './ActionMenu'
import { coverSet } from '../images'
import { SugRow } from '../pages/DiscoverParts'
import { copyLine, metaLine } from '../pages/discoverText'
import {
  axesWon,
  fmtRes,
  langGain,
  sameSource,
  sourceLabel,
  splitFolder,
  syncFields,
  variantQuality,
} from './upgradeQuality'

// SyncRequest is what the row hands up when the user wants the chosen copy:
// the WatchDialog's initial form plus the context lines it shows.
export interface SyncRequest {
  serverId: number
  name: string
  initial: WatchFields
  info: string[]
}

/** The seasons the library holds of this show, the one this upgrade touches marked. */
function LocalSeasons({ seasons, current, isMovie }: { seasons: LocalSeason[]; current: number; isMovie?: boolean }) {
  const { t } = useTranslation()
  return (
    <ul className="sg-cands" aria-label={t('suggestions.localSeasons')}>
      {seasons.map((ls) => {
        const here = !isMovie && !ls.isMovie && ls.season === current
        // a "plex:ratingKey:sN" folder is not on a mount we share: no path
        const path = ls.folder.startsWith('/') ? ls.folder : ''
        return (
          <li key={`${ls.season}-${ls.folder}`}>
            <span className={here ? 'sg-warn' : undefined}>
              {ls.isMovie
                ? t('suggestions.movie')
                : ls.season === 0
                  ? t('suggestions.specials')
                  : t('suggestions.season', { season: ls.season })}
            </span>
            <span className="mono">{path}</span>
            <span>{fmtRes(ls.resRank)}</span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * One upgrade as a row: cover, title with the season, why, the two copies
 * side by side ("jetzt" against "Server"), and the actions. The other server
 * copies and the seasons already in the library open under "N weitere
 * Fassungen". Shared by Entdecken and the assistant, so choosing and loading
 * are handed up.
 */
export default function UpgradeCard({
  u,
  dims,
  chosen,
  onChoose,
  onSync,
  onLoad,
  onDismiss,
  onOpenRemote,
  onDetails,
}: {
  u: UpgradeSuggestion
  dims: UpgradeDims | undefined
  chosen: UpgradeVariant
  onChoose: (v: UpgradeVariant) => void
  /** the sync dialog, to adjust target and naming first */
  onSync: (req: SyncRequest) => void
  /** load straight away with the plan as it stands; without it the main button opens the dialog */
  onLoad?: (req: SyncRequest, replaceOld: boolean) => void
  onDismiss?: (u: UpgradeSuggestion, from: Element | null) => void
  onOpenRemote?: (v: UpgradeVariant) => void
  onDetails?: (u: UpgradeSuggestion) => void
}) {
  const { t } = useTranslation()
  const [more, setMore] = useState(false)
  // moving the old copy aside acts on the shared library: an admin's
  const { data: me } = useAuth()
  const [replaceOld, setReplaceOld] = useState(u.sync?.replace ?? true)
  const replace = !!me?.isAdmin && replaceOld
  const isChosen = (v: UpgradeVariant) => v.serverId === chosen.serverId && v.folder === chosen.folder
  const options: UpgradeVariant[] = u.options ?? []
  const others = options.filter((o) => !isChosen(o))
  // a language gain the two copies cannot settle between them: shown as
  // unconfirmed. Recomputed, because the user may have picked another copy.
  const langUnconfirmed = !sameSource(u.from, chosen) && langGain(u.from, chosen, dims)
  const req = (): SyncRequest => ({
    serverId: chosen.serverId,
    name: u.title,
    initial: syncFields(u.sync!, u.title, chosen.folder),
    info: [
      t('watch.infoSource', {
        server: chosen.serverName || t('suggestions.localPlex'),
        quality: variantQuality(chosen, t),
      }),
      t('watch.infoLocal', { quality: variantQuality(u.from, t) }),
    ],
  })
  const canLoad = !!u.sync?.localPath
  // no target: the button stays, disabled, with the reason beside it
  const mediaServer = useMediaServer()
  const why = canLoad ? undefined : u.sync?.missing
  const season = u.isMovie ? undefined : u.season > 0 ? t('suggestions.season', { season: u.season }) : undefined
  const menu = [
    ...(canLoad ? [{ key: 'adjust', label: t('discover.adjust'), onClick: () => onSync(req()) }] : []),
    ...(u.media && onDetails ? [{ key: 'details', label: t('remote.details'), onClick: () => onDetails(u) }] : []),
    ...(u.links?.plex
      ? [
          {
            key: 'plex',
            label: t('suggestions.openPlex'),
            onClick: () => window.open(u.links!.plex, '_blank', 'noopener'),
          },
        ]
      : []),
    ...(onOpenRemote ? [{ key: 'open', label: t('plex.openBrowser'), onClick: () => onOpenRemote(chosen) }] : []),
  ]
  const chosenName = splitFolder(chosen.folder).name
  return (
    <SugRow
      title={u.title}
      season={season}
      meta={metaLine({ year: u.media?.seasonYear, category: u.category, episodes: u.episodes, library: u.library }, t)}
      cover={coverSet(u.media?.coverImage) ?? (u.cover ? { src: u.cover } : undefined)}
      coverTint={u.media?.coverImage?.color}
      onOpen={u.media && onDetails ? () => onDetails(u) : undefined}
      openLabel={t('remote.detailsFor', { name: u.title })}
    >
      {u.why && <span className="sg-why">{u.why}</span>}
      <span className="up-cmp">
        <span>
          <i>{t('discover.now')}</i>
          {copyLine(u.from, t)}
          <i>{sourceLabel(u.from, t)}</i>
        </span>
        <span data-good>
          <i>
            {isChosen(u.to) ? t('discover.server') : t('suggestions.chosenVersion')}
            {chosen.serverName ? ` · ${chosen.serverName}` : ''}
          </i>
          {copyLine(chosen, t)}
          <span className="mono" title={chosen.folder}>
            {chosenName}
          </span>
        </span>
      </span>
      <span className="sg-cand">
        {t('suggestions.basis', { axes: axesWon(u.from, chosen, dims, t) })}
        {langUnconfirmed && <span className="sg-warn"> {t('suggestions.basisLangUnverified')}</span>}
      </span>
      {(others.length > 0 || (u.localSeasons ?? []).length > 0) && (
        <button type="button" className="sg-more" aria-expanded={more} onClick={() => setMore(!more)}>
          {others.length > 0 ? t('discover.moreCopies', { count: others.length }) : t('suggestions.localSeasons')}
        </button>
      )}
      {more && options.length > 1 && (
        <fieldset className="min-w-0 border-0 p-0">
          <legend className="sr-only">{t('suggestions.chooseVersion')}</legend>
          <ul className="up-opts">
            {options.map((o, j) => (
              <li key={`${o.serverId}-${o.folder}-${j}`}>
                <label data-on={isChosen(o) || undefined}>
                  <Radio name={`opt-${u.key}`} checked={isChosen(o)} onChange={() => onChoose(o)} />
                  <span className="min-w-0">
                    <span className="block">
                      {copyLine(o, t)}
                      {o.serverName ? ` · ${o.serverName}` : ''}
                    </span>
                    <span className="mono" title={o.folder}>
                      {splitFolder(o.folder).name}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {more && (u.localSeasons ?? []).length > 0 && (
        <LocalSeasons seasons={u.localSeasons!} current={u.season} isMovie={u.isMovie} />
      )}
      {why && (
        <span className="sg-cand" id={`nt-${u.key}`}>
          {t(`discover.noTarget.${why}${u.sync?.serverPath ? 'Path' : ''}`, { path: u.sync?.serverPath })}{' '}
          {(why === 'unmapped' || why === 'not_found') &&
            (me?.isAdmin ? (
              <Link className="t-link" to={`/settings/integrations#${mediaServer || 'plex'}`}>
                {t('discover.noTarget.fix')}
              </Link>
            ) : (
              t('discover.noTarget.ask')
            ))}
        </span>
      )}
      <span className="sg-acts">
        {why && (
          <Button size="sm" variant="primary" disabled aria-describedby={`nt-${u.key}`}>
            {t('discover.upgradeLoad')}
          </Button>
        )}
        {canLoad && (
          <Button size="sm" variant="primary" onClick={() => (onLoad ? onLoad(req(), replace) : onSync(req()))}>
            {t('discover.upgradeLoad')}
          </Button>
        )}
        {canLoad && onLoad && me?.isAdmin && (
          <Checkbox
            labelClassName="sg-rep"
            checked={replaceOld}
            onChange={(e) => setReplaceOld(e.target.checked)}
            label={t('discover.replaceOld')}
          />
        )}
        {onDismiss && <TextLink onClick={(e) => onDismiss(u, e.currentTarget)}>{t('suggestions.dismiss')}</TextLink>}
        {menu.length > 0 && (
          <span className="sg-end">
            <ActionMenu label={t('discover.more')} title={u.title} actions={menu} />
          </span>
        )}
      </span>
    </SugRow>
  )
}
