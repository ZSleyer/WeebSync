// i18next init — translations bundled synchronously so the UI renders
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
  interpolation: { escapeValue: false }, // React escapes already
})

// keep <html lang> in sync (WCAG 3.1.1)
document.documentElement.lang = initial
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng
  localStorage.setItem('weebsync.locale', lng)
})

export default i18n
