import { useTranslation } from 'react-i18next'
import { LayoutGrid, List } from 'lucide-react'
import { Segmented } from 'fluid-lycoris'
import type { CatalogViewValue } from './useCatalogView'

// Katalog or Klassisch as a small grid/list switch in the page's title row, as
// file apps have it. Keeping a folder a catalog folder (the pin) is in the
// catalog's overflow menu.
export function CatalogViewSwitch({
  value,
  onChange,
}: {
  value: CatalogViewValue
  onChange: (v: CatalogViewValue) => void
}) {
  const { t } = useTranslation()
  return (
    <Segmented
      className="ws-viewsw"
      aria-label={t('remote.view')}
      value={value !== 'classic' ? 'catalog' : 'classic'}
      onChange={(v) => onChange(v === 'classic' ? 'classic' : 'catalogOnce')}
      options={[
        { value: 'catalog', label: <LayoutGrid aria-hidden size={17} />, 'aria-label': t('remote.catalog') },
        { value: 'classic', label: <List aria-hidden size={17} />, 'aria-label': t('remote.classic') },
      ]}
    />
  )
}
