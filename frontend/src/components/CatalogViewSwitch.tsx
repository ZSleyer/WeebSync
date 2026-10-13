import { useTranslation } from 'react-i18next'
import { Pin } from 'lucide-react'
import { IconButton, Segmented } from 'fluid-lycoris'
import type { CatalogViewValue } from './useCatalogView'

// Katalog or Klassisch as a full-width segmented control at the top of the
// page, and a pin beside it while the catalog is up: pressed, the folder is
// saved as a catalog folder and reopens that way.
export function CatalogViewSwitch({
  value,
  onChange,
}: {
  value: CatalogViewValue
  onChange: (v: CatalogViewValue) => void
}) {
  const { t } = useTranslation()
  const catalog = value !== 'classic'
  return (
    <div className="ws-fseg" title={t('remote.autoCatalogHint')}>
      <Segmented
        size="md"
        className="flex-1"
        aria-label={t('remote.view')}
        value={catalog ? 'catalog' : 'classic'}
        onChange={(v) => onChange(v === 'classic' ? 'classic' : 'catalogOnce')}
        options={[
          { value: 'catalog', label: t('remote.catalog') },
          { value: 'classic', label: t('remote.classic') },
        ]}
      />
      {catalog && (
        <IconButton
          className="ws-icon-sm"
          aria-pressed={value === 'catalogPersist'}
          aria-label={t('remote.catalogPersist')}
          title={t('remote.catalogPersist')}
          data-on={value === 'catalogPersist' || undefined}
          onClick={() => onChange(value === 'catalogPersist' ? 'catalogOnce' : 'catalogPersist')}
        >
          <Pin aria-hidden size={18} fill={value === 'catalogPersist' ? 'currentColor' : 'none'} />
        </IconButton>
      )}
    </div>
  )
}
