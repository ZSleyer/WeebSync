import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LOCALES } from '../../locales'

const ACCENTS = ['violet', 'acid', 'crimson', 'cyan', 'blue', 'green', 'pink', 'orange']

export default function Look() {
  const { t, i18n } = useTranslation()
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'dark')
  const [accent, setAccent] = useState(document.documentElement.dataset.accent ?? 'violet')
  const [motion, setMotion] = useState(document.documentElement.dataset.motion !== 'off')

  const applyLook = (th: string, a: string, m: boolean) => {
    const root = document.documentElement
    root.dataset.theme = th
    root.dataset.accent = a
    if (m) delete root.dataset.motion
    else root.dataset.motion = 'off'
    localStorage.setItem('weebsync.theme', th)
    localStorage.setItem('weebsync.accent', a)
    localStorage.setItem('weebsync.motion', m ? 'on' : 'off')
  }

  return (
    <section className="t-panel p-5" aria-label={t('settings.look')}>
      <span className="t-label t-label--accent">{t('settings.look')}</span>
      <div className="mt-3 grid grid-cols-1 gap-4">
        <div role="group" aria-label={t('settings.language')} className="flex items-center gap-2">
          <span className="w-24 text-xs text-t-muted">{t('settings.language')}</span>
          {LOCALES.map((l) => (
            <button
              key={l.code}
              className={`t-btn t-btn--sm ${i18n.language.startsWith(l.code) ? 't-btn--primary' : ''}`}
              aria-pressed={i18n.language.startsWith(l.code)}
              onClick={() => i18n.changeLanguage(l.code)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <div role="group" aria-label={t('settings.theme')} className="flex items-center gap-2">
          <span className="w-24 text-xs text-t-muted">{t('settings.theme')}</span>
          {(['dark', 'light'] as const).map((th) => (
            <button
              key={th}
              className={`t-btn t-btn--sm ${theme === th ? 't-btn--primary' : ''}`}
              aria-pressed={theme === th}
              onClick={() => {
                setTheme(th)
                applyLook(th, accent, motion)
              }}
            >
              {th}
            </button>
          ))}
        </div>
        <div role="group" aria-label={t('settings.accent')} className="flex items-center gap-2">
          <span className="w-24 text-xs text-t-muted">{t('settings.accent')}</span>
          <div className="flex flex-wrap gap-2">
            {ACCENTS.map((a) => (
              <button
                key={a}
                title={a}
                aria-pressed={accent === a}
                aria-label={t('settings.accentName', { name: a })}
                className={`h-6 w-6 border ${accent === a ? 'border-t-primary outline outline-2 outline-accent' : 'border-border-subtle'}`}
                style={{ backgroundColor: `var(--accent-blue)` }}
                data-accent={a}
                onClick={() => {
                  setAccent(a)
                  applyLook(theme, a, motion)
                }}
              />
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-t-secondary">
          <input
            type="checkbox"
            checked={motion}
            onChange={(e) => {
              setMotion(e.target.checked)
              applyLook(theme, accent, e.target.checked)
            }}
          />
          {t('settings.motion')}
        </label>
      </div>
    </section>
  )
}
