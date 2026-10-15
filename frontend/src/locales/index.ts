// i18next init - translations bundled synchronously so the UI renders
// translated on first paint (same pattern as Encounty).
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import de from './de.json'
import en from './en.json'

export type Locale = 'de' | 'en'
export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'de', label: 'Deutsch' },
  { code: 'en', label: 'English' },
]

const saved = localStorage.getItem('weebsync.locale')
const system: Locale = navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en'
const initial: Locale = saved === 'de' || saved === 'en' ? saved : system

i18n.use(initReactI18next).init({
  resources: { de: { translation: de }, en: { translation: en } },
  lng: initial,
  fallbackLng: 'en',
  // escapeValue: React escapes already. {{mediaServer}} is the configured media
  // server's name in every text, see setMediaServerName.
  interpolation: { escapeValue: false, defaultVariables: { mediaServer: 'Plex' } },
  react: { bindI18n: 'languageChanged mediaServer' },
})

// setMediaServerName puts Plex or Jellyfin into every {{mediaServer}} and re-renders
// the texts that use it.
export function setMediaServerName(kind: string | undefined) {
  const name = kind === 'jellyfin' ? 'Jellyfin' : 'Plex'
  const vars = i18n.options.interpolation?.defaultVariables
  if (!vars || vars.mediaServer === name) return
  vars.mediaServer = name // in place: the translator holds this same object
  i18n.emit('mediaServer')
}

// keep <html lang> in sync (WCAG 3.1.1)
document.documentElement.lang = initial
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng
  localStorage.setItem('weebsync.locale', lng)
  syncLocale(lng)
})

// tell the backend, so server-delivered texts (email, web push) match the ui
// language; fire-and-forget - fails silently when logged out
export function syncLocale(lng: string) {
  fetch('/api/auth/locale', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale: lng }),
  }).catch(() => {})
}

export default i18n
