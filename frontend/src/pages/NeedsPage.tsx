import { useTranslation } from 'react-i18next'
import { EmptyState, PageHeader, SectionHeading } from 'fluid-lycoris'
import { useNeedList } from './today/NeedRows'
import { groupNeeds } from './today/needs'
import { useNeedsData } from './today/useNeedsData'
import './today/today.css'

/**
 * "Braucht dich" in full: every need, grouped by what it asks of the user -
 * problems to fix, decisions to take, and what Auto-Sync holds back. The rows
 * are Today's own (same swipe, detail sheet, hide and undo), and so is the
 * list they come from: the count here is the count on the app icon.
 */
export default function NeedsPage() {
  const { t } = useTranslation()
  const { downloads, isLoading, meta, watches, watchesLoading, detected, plexToken, mediaChoose } = useNeedsData()
  const loading = isLoading || watchesLoading
  const { shown, row, dialog } = useNeedList({ downloads, meta, watches, detected, plexToken, mediaChoose })
  const groups = groupNeeds(shown)
  let index = 0
  return (
    <div className="flex flex-col">
      <PageHeader className="mb-4" title={t('needs.title')} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
        {loading ? (
          <ul className="t-rows td-needs">
            {[0, 1, 2].map((i) => (
              <li key={i} aria-hidden className="td-sk-row" />
            ))}
          </ul>
        ) : groups.length === 0 ? (
          <EmptyState label={t('needs.empty')}>{t('needs.emptyHint')}</EmptyState>
        ) : (
          groups.map((g) => (
            <section key={g.group} aria-labelledby={`needs-${g.group}`}>
              <SectionHeading
                id={`needs-${g.group}`}
                title={t(`needs.group.${g.group}`)}
                tone={g.group === 'sync' ? 'accent-2' : 'accent'}
                action={<span className="td-count">{g.needs.length}</span>}
              />
              <ul className="t-rows td-needs">{g.needs.map((n) => row(n, index++))}</ul>
            </section>
          ))
        )}
      </div>
      {dialog}
    </div>
  )
}
