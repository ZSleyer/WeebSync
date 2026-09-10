import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { Badge, Checkbox, Panel, Segmented } from '@weebsync/design-system'
import { LOCALES } from '../../locales'
import { applyTheme, readThemePref, THEME_KEY, type ThemePref } from '../../theme'

const ACCENTS = ['orange', 'acid', 'crimson', 'cyan', 'blue', 'green', 'pink', 'violet'] as const
const THEMES: ThemePref[] = ['system', 'dark', 'light']

// label above its control on a phone, in a column beside it from sm up
const ROW = 'grid gap-2 sm:grid-cols-[6rem_1fr] sm:items-center'
const LABEL = 'text-xs text-t-muted'

// Every choice here applies at once and is the preview of itself: the page
// is painted in the accent it picks. Stored per browser, no save button.
export default function Look() {
  const { t, i18n } = useTranslation()
  const root = document.documentElement
  const [theme, setTheme] = useState<ThemePref>(readThemePref)
  const [accent, setAccent] = useState(root.dataset.accent ?? 'orange')
  const [motion, setMotion] = useState(root.dataset.motion !== 'off')
  const lang = LOCALES.find((l) => i18n.language.startsWith(l.code))?.code ?? LOCALES[0].code

  const pickTheme = (th: ThemePref) => {
    setTheme(th)
    localStorage.setItem(THEME_KEY, th)
    applyTheme(th)
  }
  const pickAccent = (a: string) => {
    setAccent(a)
    root.dataset.accent = a
    localStorage.setItem('weebsync.accent', a)
  }
  const pickMotion = (m: boolean) => {
    setMotion(m)
    if (m) delete root.dataset.motion
    else root.dataset.motion = 'off'
    localStorage.setItem('weebsync.motion', m ? 'on' : 'off')
  }

  return (
    <Panel as="section" className="p-5" aria-label={t('settings.look')}>
      <Badge tone="accent">{t('settings.look')}</Badge>
      <div className="mt-3 flex flex-col gap-4">
        <div className={ROW}>
          <span className={LABEL}>{t('settings.language')}</span>
          <Segmented
            aria-label={t('settings.language')}
            value={lang}
            onChange={(code) => i18n.changeLanguage(code)}
            options={LOCALES.map((l) => ({ value: l.code, label: l.label }))}
          />
        </div>
        <div className={ROW}>
          <span className={LABEL}>{t('settings.theme')}</span>
          <Segmented
            aria-label={t('settings.theme')}
            value={theme}
            onChange={pickTheme}
            options={THEMES.map((th) => ({ value: th, label: t(`settings.theme_${th}`) }))}
          />
        </div>
        <div role="radiogroup" aria-label={t('settings.accent')} className={ROW}>
          <span className={LABEL}>{t('settings.accent')}</span>
          <div className="flex flex-wrap gap-x-3 gap-y-2">
            {ACCENTS.map((a) => (
              <label key={a} className="flex cursor-pointer flex-col items-center gap-1">
                <input
                  type="radio"
                  name="accent"
                  value={a}
                  checked={accent === a}
                  onChange={() => pickAccent(a)}
                  className="peer sr-only"
                />
                {/* the swatch paints its own preset: the [data-accent] rules
                    redefine the accent variable on this very element, which
                    the frozen theme token (bg-accent) would not follow */}
                <span
                  aria-hidden
                  data-accent={a}
                  className="grid size-8 place-items-center rounded-full bg-[var(--accent-blue)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-t-primary [@media(pointer:coarse)]:size-11"
                >
                  {accent === a && <Check size="1.1em" strokeWidth={3} className="text-bg-primary" />}
                </span>
                <span className="text-[11px] text-t-muted peer-checked:text-t-primary">{t(`settings.accents.${a}`)}</span>
              </label>
            ))}
          </div>
        </div>
        <Checkbox
          label={t('settings.motion')}
          labelClassName="text-t-secondary"
          checked={motion}
          onChange={(e) => pickMotion(e.target.checked)}
        />
      </div>
    </Panel>
  )
}
