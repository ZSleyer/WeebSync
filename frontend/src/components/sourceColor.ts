import type { CSSProperties } from 'react'

// The tints a source's entries carry where several sources meet, the search
// across every index first among them. Names are what the backend stores
// (its allowlist mirrors this map), values are hues: lightness and chroma
// come from the theme (--src-l, --src-c), so a tint reads on both grounds.
export const SOURCE_COLORS = {
  orange: 50,
  amber: 80,
  lime: 125,
  green: 150,
  teal: 180,
  cyan: 210,
  blue: 250,
  violet: 290,
  pink: 340,
  red: 20,
} as const
export type SourceColorName = keyof typeof SOURCE_COLORS
const NAMES = Object.keys(SOURCE_COLORS) as SourceColorName[]

// the local library's tint is a look of this device, like the accent
const LOCAL_KEY = 'weebsync.localColor'
export const LOCAL_DEFAULT: SourceColorName = 'green'
export function localColor(): SourceColorName {
  try {
    const v = localStorage.getItem(LOCAL_KEY)
    return v && v in SOURCE_COLORS ? (v as SourceColorName) : LOCAL_DEFAULT
  } catch {
    return LOCAL_DEFAULT
  }
}
export function setLocalColor(name: SourceColorName) {
  try {
    localStorage.setItem(LOCAL_KEY, name)
  } catch {
    /* storage off: the default stays */
  }
}

/** A server's chosen tint, or one picked from its id so two servers differ. */
export function serverColor(id: number, chosen?: string): SourceColorName {
  return chosen && chosen in SOURCE_COLORS ? (chosen as SourceColorName) : NAMES[(id * 7) % NAMES.length]
}

/** The inline style that sets a tint for `.t-src` and its children. */
export const tint = (name: SourceColorName) => ({ '--src-h': SOURCE_COLORS[name] }) as CSSProperties
