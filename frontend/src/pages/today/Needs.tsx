import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { SectionHeading } from 'fluid-lycoris'
import type { Download, DownloadMeta, Watch } from '../../api'
import { LoadError } from './LoadError'
import { useNeedList } from './NeedRows'
import { moreLink } from './needs'
import { useFold, useRiseOnData } from './shared'

/** rows shown before "N more" */
export const NEEDS_MAX = 5

/**
 * "Braucht dich" on Today: the first rows of the needs, problems first, one
 * row each with its reason and one action. A swipe to the right runs the
 * action, to the left hides the row (a failed download is removed instead);
 * the same is a button for mouse and keyboard. Either leaves at once and can
 * be taken back from the toast. The heading's link and "+N more" lead to the
 * page with all of them.
 */
export function Needs({
  downloads,
  meta,
  watches,
  detected,
  plexToken,
  mediaChoose,
  loading,
  failed,
  onRetry,
}: {
  downloads: Download[]
  meta?: DownloadMeta
  watches: Watch[]
  /** folders WeebSync marked on its own that the user has not looked at yet */
  detected: number
  /** an admin's Plex runs on a pasted token */
  plexToken?: boolean
  /** Plex and Jellyfin both connected, neither chosen */
  mediaChoose?: boolean
  loading: boolean
  /** the data could not be read: say so instead of "nothing open" */
  failed?: boolean
  onRetry?: () => unknown
}) {
  const { t } = useTranslation()
  const { shown, row, dialog } = useNeedList({ downloads, meta, watches, detected, plexToken, mediaChoose })
  const body = useRef<HTMLDivElement>(null)
  useRiseOnData(body, !loading)
  const rows = shown.slice(0, NEEDS_MAX)
  const fold = useFold('needs')
  return (
    <section aria-labelledby="td-needs-h">
      <SectionHeading
        id="td-needs-h"
        title={t('today.needs')}
        action={
          !loading && (
            <Link to={moreLink()} className="t-link td-count">
              {t('needs.all', { count: shown.length })}
            </Link>
          )
        }
        fold={fold}
      />
      <div ref={body} id={fold.controls} hidden={!fold.open}>
        <LoadError failed={!!failed && !loading && rows.length === 0} onRetry={() => onRetry?.()} />
        <ul className="t-rows td-needs">
          {loading
            ? [0, 1].map((i) => <li key={i} aria-hidden className="td-sk-row" />)
            : rows.map((n, i) => row(n, i))}
          {!loading && rows.length === 0 && !failed && <li className="td-empty">{t('today.nothingOpen')}</li>}
        </ul>
        {shown.length > rows.length && (
          <Link to={moreLink()} className="t-link td-more">
            {t('dash.attentionMore', { count: shown.length - rows.length })}
          </Link>
        )}
      </div>
      {dialog}
    </section>
  )
}
