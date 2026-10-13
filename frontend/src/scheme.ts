import { setFavicon } from './favicon'

// The colour scheme: which half of the colour code leads. Lycoris (the
// default) keeps the accent red and accent-2 teal, Recoil swaps them. Free
// accent colours are gone because they broke the code's meaning.

export type Scheme = 'lycoris' | 'recoil'
export const SCHEMES: Scheme[] = ['lycoris', 'recoil']
export const SCHEME_KEY = 'weebsync.scheme'
/** where the free accent colour used to be stored */
const LEGACY_ACCENT_KEY = 'weebsync.accent'
const LEGACY_ACCENT_V2_KEY = 'weebsync.accent.v2'
/** the old accents that were teal, blue or green: their owner wanted the cool side, which is Recoil */
const COOL_ACCENTS = new Set(['cyan', 'blue', 'green'])

/** The scheme from what is stored: a scheme as is, else the closest match for an old accent, else Lycoris. */
export function schemeFromStored(scheme: string | null, legacyAccent: string | null): Scheme {
  if (SCHEMES.includes(scheme as Scheme)) return scheme as Scheme
  return legacyAccent && COOL_ACCENTS.has(legacyAccent) ? 'recoil' : 'lycoris'
}

/** Read the stored scheme, moving an old accent choice over to its scheme once. */
export function readScheme(): Scheme {
  try {
    const stored = localStorage.getItem(SCHEME_KEY)
    const legacy = localStorage.getItem(LEGACY_ACCENT_KEY)
    const scheme = schemeFromStored(stored, legacy)
    if (stored !== scheme) localStorage.setItem(SCHEME_KEY, scheme)
    localStorage.removeItem(LEGACY_ACCENT_KEY)
    localStorage.removeItem(LEGACY_ACCENT_V2_KEY)
    return scheme
  } catch {
    return 'lycoris'
  }
}

/** Paint the document in a scheme; the tab icon follows the accent. */
export function applyScheme(scheme: Scheme) {
  const root = document.documentElement
  if (scheme === 'lycoris') delete root.dataset.scheme
  else root.dataset.scheme = scheme
  delete root.dataset.accent
  setFavicon()
}
