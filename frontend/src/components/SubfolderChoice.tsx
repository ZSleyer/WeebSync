import { useTranslation } from 'react-i18next'
import { Field, Segmented, Select } from '@weebsync/design-system'
import type { SubfolderMode } from '../api'
import { titleFolder } from './useTargetFolder'

// SubfolderChoice picks the folder a sync creates below its target: none, the
// remote folder's name, or the series title. The title variant is resolved
// where this control is used and stored as part of the target path, so the
// separator is its own choice - a library folder usually keeps its spaces
// where the file names do not.
//
// title empty (the settings page, which has no series in front of it) shows
// the sample name instead of a preview.
export default function SubfolderChoice({
  value,
  onChange,
  separator,
  onSeparator,
  title,
  className,
}: {
  value: SubfolderMode
  onChange: (m: SubfolderMode) => void
  separator: string
  onSeparator: (s: string) => void
  /** the resolved series title; empty falls back to the remote folder's name */
  title?: string
  className?: string
}) {
  const { t } = useTranslation()
  const sample = title || t('watch.subfolderSample')
  return (
    <div className={className}>
      <span className="mb-1 block text-xs text-t-muted" aria-hidden>
        {t('watch.subfolderMode')}
      </span>
      <Segmented
        aria-label={t('watch.subfolderMode')}
        value={value}
        onChange={onChange}
        options={[
          { value: 'none' as const, label: t('watch.subfolderNone') },
          { value: 'remote' as const, label: t('watch.subfolderRemote') },
          { value: 'title' as const, label: t('watch.subfolderTitle') },
        ]}
      />
      {value === 'title' && (
        <div className="mt-3 space-y-2">
          <Field label={t('watch.subfolderSeparator')}>
            <Select value={separator} onChange={(e) => onSeparator(e.target.value)}>
              <option value="">{t('rename.sepSpace')}</option>
              <option value="_">{t('rename.sepUnderscore')}</option>
              <option value=".">{t('rename.sepDot')}</option>
              <option value="-">{t('rename.sepDash')}</option>
            </Select>
          </Field>
          <p className="text-[11px] text-t-muted">
            {t('watch.subfolderPreview')} <span className="font-mono text-t-secondary">{titleFolder(sample, separator)}</span>
          </p>
          {title === '' && <p className="text-[11px] text-t-muted">{t('watch.subfolderTitleUnknown')}</p>}
          <p className="text-[11px] text-t-muted">{t('watch.subfolderTitleHint')}</p>
        </div>
      )}
    </div>
  )
}
