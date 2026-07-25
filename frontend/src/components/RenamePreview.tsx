import { useTranslation } from 'react-i18next'
import { Badge } from '@weebsync/design-system'
import type { Entry, RenamePair } from '../api'
import Loading from './Loading'
import { TARGET_LABEL, classifyTargets, type TargetStatus } from './useTargetFolder'

const TONE: Record<TargetStatus, 'ok' | 'warn' | 'neutral'> = {
  new: 'ok',
  replaces: 'warn',
  same: 'neutral',
}

// The dry-run of a sync: what each remote file will be called, and what that
// name meets in the target folder. Shared by the watch dialog and the sync
// dialog, which showed the same block twice.
export default function RenamePreview({
  pairs,
  sizes,
  target,
  busy,
}: {
  pairs: RenamePair[] | null
  sizes: Record<string, number>
  /** listing of the target folder: null = not there yet, undefined = unknown */
  target: Entry[] | null | undefined
  busy?: boolean
}) {
  const { t } = useTranslation()
  const status = classifyTargets(pairs ?? [], sizes, target)
  const replaced = Object.values(status).filter((s) => s === 'replaces').length

  return (
    <section className="space-y-2 border-t border-border-subtle pt-4" aria-label={t('rename.preview')}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{t('rename.preview')}</Badge>
        {busy && <Loading />}
        {/* the count carries the warning: a single row scrolled out of view is
            easy to miss, the total is not */}
        {replaced > 0 && <Badge tone="warn">{t('rename.targetReplacesCount', { count: replaced })}</Badge>}
      </div>
      {pairs && (
        <div className="max-h-56 overflow-y-auto border border-border-subtle">
          {pairs.length === 0 && <p className="p-2 text-xs text-t-muted">{t('remote.emptyDir')}</p>}
          {pairs.map((p) => (
            <p
              key={p.old}
              className="flex items-baseline gap-2 border-b border-border-subtle/50 px-2 py-1 font-mono text-[11px]"
            >
              <span className="min-w-0 flex-1 break-all">
                <span className="text-t-muted">{p.old}</span>
                {(p.error || p.new !== p.old) && (
                  <>
                    <span className="text-t-faint"> → </span>
                    <span className={p.error ? 'text-err' : 'text-accent'}>{p.error ?? p.new}</span>
                  </>
                )}
              </span>
              {status[p.old] && (
                <Badge size="sm" tone={TONE[status[p.old]]} className="shrink-0">
                  {t(TARGET_LABEL[status[p.old]])}
                </Badge>
              )}
            </p>
          ))}
        </div>
      )}
    </section>
  )
}
