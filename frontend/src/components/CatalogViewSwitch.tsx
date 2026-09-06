import { useTranslation } from 'react-i18next'
import { Select } from '@weebsync/design-system'
import type { CatalogViewValue } from './useCatalogView'

// The Klassisch / Katalog (einmalig) / Katalog (dauerhaft) dropdown, shared by
// the Remote and Local browsers. Labelled so the persistence difference is
// obvious to any user.
export function CatalogViewSelect({ value, onChange }: { value: CatalogViewValue; onChange: (v: CatalogViewValue) => void }) {
  const { t } = useTranslation()
  return (
    // min-w-44: "Katalog (dauerhaft)" needs 150px, and a select clips its
    // label silently rather than scrolling - so the control keeps the width of
    // its longest option and the row wraps instead
    // on a phone the control sits in the app bar without its caption (the
    // accessible name stays), on desktop in the page header with it
    <label className="text-xs text-t-muted lg:min-w-44" title={t('remote.autoCatalogHint')}>
      <span className="sr-only lg:not-sr-only">{t('remote.view')}</span>
      <Select
        wrapperClassName="lg:mt-1 lg:w-44"
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
