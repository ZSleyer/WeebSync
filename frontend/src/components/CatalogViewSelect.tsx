import { useTranslation } from 'react-i18next'
import { Select } from '@weebsync/design-system'
import type { CatalogViewValue } from './useCatalogView'

// The Klassisch / Katalog (einmalig) / Katalog (dauerhaft) dropdown, shared by
// the Remote and Local browsers. Labelled so the persistence difference is
// obvious to any user.
export function CatalogViewSelect({ value, onChange }: { value: CatalogViewValue; onChange: (v: CatalogViewValue) => void }) {
  const { t } = useTranslation()
  return (
    <label className="flex-1 text-xs text-t-muted sm:flex-none" title={t('remote.autoCatalogHint')}>
      {t('remote.view')}
      <Select
        wrapperClassName="mt-1 sm:w-44"
        value={value}
        onChange={(e) => onChange(e.target.value as CatalogViewValue)}
      >
        <option value="classic">{t('remote.classic')}</option>
        <option value="catalogOnce">{t('remote.catalogOnce')}</option>
        <option value="catalogPersist">{t('remote.catalogPersist')}</option>
      </Select>
    </label>
  )
}
