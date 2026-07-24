import { useTranslation } from 'react-i18next'
import LegacyImport from '../../components/LegacyImport'

export default function Import() {
  const { t } = useTranslation()
  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-display text-lg font-semibold tracking-wider">{t('legacy.title')}</h3>
        {/* the upstream link lives in LegacyImport itself, so it shows up in the
            setup wizard too and is never printed twice here */}
        <p className="mt-1 text-xs text-t-muted">{t('legacy.sub')}</p>
      </div>
      <LegacyImport />
    </div>
  )
}
