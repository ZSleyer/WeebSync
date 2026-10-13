import { useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Badge, Checkbox, Panel, revealTransition, Segmented } from 'fluid-lycoris'
import { LOCALES } from '../../locales'
import { applyTheme, readThemePref, THEME_KEY, type ThemePref } from '../../theme'
import { applyScheme, SCHEME_KEY, SCHEMES, type Scheme } from '../../scheme'

const THEMES: ThemePref[] = ['system', 'dark', 'light']

// label above its control on a phone, in a column beside it from sm up
const ROW = 'grid gap-2 sm:grid-cols-[6rem_1fr] sm:items-center'
const LABEL = 'text-xs text-t-muted'

// Every choice here applies at once and is the preview of itself: the page
// is painted in the scheme it picks. Stored per browser, no save button.
export default function Look() {
  const { t, i18n } = useTranslation()
  const root = document.documentElement
  const [theme, setTheme] = useState<ThemePref>(readThemePref)
  const [scheme, setScheme] = useState<Scheme>(root.dataset.scheme === 'recoil' ? 'recoil' : 'lycoris')
  const [motion, setMotion] = useState(root.dataset.motion !== 'off')
  const lang = LOCALES.find((l) => i18n.language.startsWith(l.code))?.code ?? LOCALES[0].code

  const pickTheme = (th: ThemePref) => {
    setTheme(th)
    localStorage.setItem(THEME_KEY, th)
    applyTheme(th)
  }
  // the new scheme spreads from the option that was picked, over the whole
  // page - the page is the preview of the choice
  const pickScheme = (s: Scheme) => {
    const apply = () => {
      flushSync(() => setScheme(s))
      applyScheme(s)
    }
    localStorage.setItem(SCHEME_KEY, s)
    const r = (document.activeElement as HTMLElement | null)?.getBoundingClientRect()
    if (r && r.width) void revealTransition(r.left + r.width / 2, r.top + r.height / 2, apply)
    else apply()
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
        <div className={ROW}>
          <span className={LABEL}>{t('settings.scheme')}</span>
          <div className="flex flex-col gap-1">
            <Segmented
              aria-label={t('settings.scheme')}
              value={scheme}
              onChange={pickScheme}
              options={SCHEMES.map((s) => ({
                value: s,
                label: (
                  // each option shows its own pair: the lead colour first
                  <span className="inline-flex items-center gap-2">
                    <span aria-hidden data-scheme={s} className="inline-flex">
                      <span className="size-2.5 rounded-full bg-[var(--accent)]" />
                      <span className="-ml-1 size-2.5 rounded-full bg-[var(--accent-2)]" />
                    </span>
                    {t(`settings.schemes.${s}`)}
                  </span>
                ),
              }))}
            />
            <span className="text-ctl-sm text-t-muted">{t(`settings.schemeHint.${scheme}`)}</span>
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
