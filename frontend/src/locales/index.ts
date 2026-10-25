// i18next init - translations bundled synchronously so the UI renders
// translated on first paint (same pattern as Encounty).
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// Every <code>.json next to this file is a locale: dropping in fr.json is all
// it takes to offer French, here and in the language setting.
const files = import.meta.glob<Record<string, unknown>>('./*.json', { eager: true, import: 'default' })
const resources: Record<string, { translation: Record<string, unknown> }> = Object.fromEntries(
  Object.entries(files).map(([path, translation]) => [path.slice(2, -'.json'.length), { translation }]),
)

export type Locale = string
// The language setting: one of the locales, or 'system' to follow the
// browser's language list (the default when nothing was chosen yet).
export type LocalePref = Locale | 'system'

// a locale's name in its own language ("Deutsch", "English")
const ownName = (code: string) => {
  const name = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code
  return name.charAt(0).toLocaleUpperCase(code) + name.slice(1)
}
export const LOCALES: { code: Locale; label: string }[] = Object.keys(resources)
  .sort()
  .map((code) => ({ code, label: ownName(code) }))

const FALLBACK: Locale = 'en'
export const LOCALE_KEY = 'weebsync.locale'

const browserLanguages = (): readonly string[] =>
  navigator.languages?.length ? navigator.languages : [navigator.language]

// resolveSystemLocale walks the browser's preferred languages in order and
// takes the first one a locale exists for, by primary subtag: de-AT is de.
// Nothing matching falls back to English.
export function resolveSystemLocale(languages: readonly string[] = browserLanguages()): Locale {
  for (const tag of languages) {
    const primary = tag?.split(/[-_]/)[0]?.toLowerCase()
    if (primary && Object.hasOwn(resources, primary)) return primary
  }
  return FALLBACK
}

// readLocalePref: an explicit choice stays; anything else (nothing stored,
// a locale since removed, blocked storage) follows the system
export function readLocalePref(): LocalePref {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(LOCALE_KEY)
  } catch {
    // blocked storage: follow the system for this visit
  }
  return saved && Object.hasOwn(resources, saved) ? saved : 'system'
}

const localeOf = (pref: LocalePref) => (pref === 'system' ? resolveSystemLocale() : pref)

const initial = localeOf(readLocalePref())

i18n.use(initReactI18next).init({
  resources,
  lng: initial,
  fallbackLng: FALLBACK,
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
  syncLocale(lng)
})

// setLocalePref stores the language setting and applies it. Only this call
// stores: a language that merely followed the system is never written down
// as if it had been chosen, so the setting keeps following it.
export function setLocalePref(pref: LocalePref) {
  try {
    if (pref === 'system') localStorage.removeItem(LOCALE_KEY)
    else localStorage.setItem(LOCALE_KEY, pref)
  } catch {
    // applied for this visit, just not remembered
  }
  return i18n.changeLanguage(localeOf(pref))
}

// while the setting is 'system', a change of the browser's language list
// takes effect at once
window.addEventListener('languagechange', () => {
  if (readLocalePref() !== 'system') return
  const lng = resolveSystemLocale()
  if (lng !== i18n.language) void i18n.changeLanguage(lng)
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
