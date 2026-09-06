import { useTranslation } from 'react-i18next'
import { LayoutGrid, List, Pin } from 'lucide-react'
import { Button, Segmented } from '@weebsync/design-system'
import type { CatalogViewValue } from './useCatalogView'

// Classic or catalog as one pressed-button group, the same control the
// auto-sync page uses for list and calendar, and a pin next to it while the
// catalog is up: pressed, the folder is saved as a catalog folder and reopens
// that way. Icons alone in the app bar on a phone, icon and label on desktop.
export function CatalogViewSwitch({ value, onChange }: { value: CatalogViewValue; onChange: (v: CatalogViewValue) => void }) {
  const { t } = useTranslation()
  const catalog = value !== 'classic'
  const opt = (v: 'classic' | 'catalog', icon: React.ReactNode) => ({
    value: v,
    'aria-label': t(`remote.${v}`),
    label: (
      <>
        {icon}
        <span className="ml-1 hidden lg:inline">{t(`remote.${v}`)}</span>
      </>
    ),
  })
  return (
    <div className="flex items-center gap-2" title={t('remote.autoCatalogHint')}>
      <Segmented
        aria-label={t('remote.view')}
        value={catalog ? 'catalog' : 'classic'}
        onChange={(v) => onChange(v === 'classic' ? 'classic' : 'catalogOnce')}
        options={[opt('classic', <List aria-hidden size="1em" />), opt('catalog', <LayoutGrid aria-hidden size="1em" />)]}
      />
      {catalog && (
        <Button
          size="sm"
          variant={value === 'catalogPersist' ? 'primary' : 'default'}
          aria-pressed={value === 'catalogPersist'}
          aria-label={t('remote.catalogPersist')}
          title={t('remote.catalogPersist')}
          onClick={() => onChange(value === 'catalogPersist' ? 'catalogOnce' : 'catalogPersist')}
        >
          <Pin aria-hidden size="1em" />
        </Button>
      )}
    </div>
  )
}
