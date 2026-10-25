import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { revealTransition, Segmented, SettingsField } from 'fluid-lycoris'
import { LOCALES, readLocalePref, setLocalePref, type LocalePref } from '../../locales'
import { applyTheme, readThemePref, THEME_KEY, type ThemePref } from '../../theme'
import { applyScheme, SCHEME_KEY, SCHEMES, type Scheme } from '../../scheme'
import { SettingsPanel, SwitchSetting } from './ui'

// a blocked storage (private window) keeps the choice for this visit only
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // applied already, just not remembered
  }
}

const THEMES: ThemePref[] = ['system', 'dark', 'light']

// Every choice here applies at once and is the preview of itself: the page
// is painted in the scheme it picks. Stored per browser, no save button.
export default function Look() {
  const { t } = useTranslation()
  const root = document.documentElement
  const [theme, setTheme] = useState<ThemePref>(readThemePref)
  const [scheme, setScheme] = useState<Scheme>(root.dataset.scheme === 'recoil' ? 'recoil' : 'lycoris')
  const [motion, setMotion] = useState(root.dataset.motion !== 'off')
  const [lang, setLang] = useState<LocalePref>(readLocalePref)
  const schemeLabel = useId()
  const cards = useRef<(HTMLButtonElement | null)[]>([])

  const pickLang = (l: LocalePref) => {
    setLang(l)
    void setLocalePref(l)
  }
  const pickTheme = (th: ThemePref) => {
    setTheme(th)
    applyTheme(th)
    store(THEME_KEY, th)
  }
  // the new scheme spreads from the card that was picked, over the whole
  // page - the page is the preview of the choice
  const pickScheme = (s: Scheme, from?: HTMLElement | null) => {
    if (s === scheme) return
    const apply = () => {
      flushSync(() => setScheme(s))
      applyScheme(s)
    }
    store(SCHEME_KEY, s)
    const r = from?.getBoundingClientRect()
    if (r && r.width) void revealTransition(r.left + r.width / 2, r.top + r.height / 2, apply)
    else apply()
  }
  // a radio group: the arrows move the choice and apply it at once
  const onSchemeKey = (e: KeyboardEvent, i: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    if (!step) return
    e.preventDefault()
    const next = (i + step + SCHEMES.length) % SCHEMES.length
    const el = cards.current[next]
    el?.focus()
    pickScheme(SCHEMES[next], el)
  }
  const pickMotion = (m: boolean) => {
    setMotion(m)
    if (m) delete root.dataset.motion
    else root.dataset.motion = 'off'
    store('weebsync.motion', m ? 'on' : 'off')
  }

  return (
    <SettingsPanel title={t('settings.look')} desc={t('settings.lookDesc')}>
      <SettingsField label={t('settings.language')} hint={t('settings.languageHint')}>
        <Segmented
          aria-label={t('settings.language')}
          value={lang}
          onChange={pickLang}
          options={[
            { value: 'system', label: t('settings.language_system') },
            ...LOCALES.map((l) => ({ value: l.code, label: l.label })),
          ]}
        />
      </SettingsField>
      <SettingsField label={t('settings.theme')}>
        <Segmented
          aria-label={t('settings.theme')}
          value={theme}
          onChange={pickTheme}
          options={THEMES.map((th) => ({ value: th, label: t(`settings.theme_${th}`) }))}
        />
      </SettingsField>
      <div className="t-sf">
        <div className="t-sf-l">
          <span id={schemeLabel}>{t('settings.scheme')}</span>
        </div>
        <div role="radiogroup" aria-labelledby={schemeLabel} className="set-schemes">
          {SCHEMES.map((s, i) => (
            <button
              key={s}
              ref={(el) => {
                cards.current[i] = el
              }}
              type="button"
              role="radio"
              aria-checked={scheme === s}
              tabIndex={scheme === s ? 0 : -1}
              className="set-scheme"
              onClick={(e) => pickScheme(s, e.currentTarget)}
              onKeyDown={(e) => onSchemeKey(e, i)}
            >
              {/* each card shows its own pair, the lead colour first */}
              <span aria-hidden data-scheme={s} className="set-scheme-sw">
                <span />
                <span />
              </span>
              <span className="set-scheme-t">
                <strong>{t(`settings.schemes.${s}`)}</strong>
                <span>{t(`settings.schemeHint.${s}`)}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="t-sf-h">{t('settings.schemePair')}</p>
      </div>
      <SwitchSetting
        label={t('settings.motion')}
        hint={t('settings.motionHint')}
        checked={motion}
        onChange={pickMotion}
      />
    </SettingsPanel>
  )
}
