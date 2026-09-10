import { setFavicon } from './favicon'

// The look's theme choice. "system" follows the OS and keeps following it
// while the tab is open, the other two are fixed. Nothing stored means system.
export type ThemePref = 'system' | 'dark' | 'light'
export type Theme = 'dark' | 'light'

export const THEME_KEY = 'weebsync.theme'
const PREFS: ThemePref[] = ['system', 'dark', 'light']
const DARK_MQ = '(prefers-color-scheme: dark)'
// the browser's own chrome (address bar, task switcher) takes the app's
// secondary surface, the colour the app bar and sidebar sit on
const BAR_COLOR: Record<Theme, string> = { dark: '#0b0b0d', light: '#f8fafb' }

export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref
}

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return PREFS.includes(v as ThemePref) ? (v as ThemePref) : 'system'
  } catch {
    return 'system'
  }
}

let unwatch: (() => void) | undefined

function paint(theme: Theme) {
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR_COLOR[theme])
  // the accent has a shade per mode, and the tab icon carries the accent
  setFavicon()
}

/** Apply a preference to the document: sets the theme and, for "system", follows the OS from then on. */
export function applyTheme(pref: ThemePref) {
  unwatch?.()
  unwatch = undefined
  const mq = typeof matchMedia === 'function' ? matchMedia(DARK_MQ) : undefined
  paint(resolveTheme(pref, !!mq?.matches))
  if (pref !== 'system' || !mq) return
  const onChange = (e: MediaQueryListEvent) => paint(resolveTheme('system', e.matches))
  mq.addEventListener('change', onChange)
  unwatch = () => mq.removeEventListener('change', onChange)
}
