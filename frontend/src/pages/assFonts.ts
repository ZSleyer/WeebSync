// the font families an ASS script asks for: its styles' fonts and every \fn
// override, lower-case like libass asks for them. A leading @ (vertical text)
// names the same family.
export function scriptFamilies(ass: string): string[] {
  const names = [...ass.matchAll(STYLE_FONT), ...ass.matchAll(FN_TAG)].map((m) => key(m[2]))
  return [...new Set(names)].filter(Boolean)
}

// renameFamilies points the script's styles and \fn overrides at other
// families (keyed lower-case): libass finds a font by the name inside it, so
// a script naming Calibri never gets Carlito unless it names Carlito.
export function renameFamilies(ass: string, to: Record<string, string>): string {
  const swap = (_: string, head: string, name: string) => {
    const k = key(name)
    return head + (k in to ? (name.trim().startsWith('@') ? '@' : '') + to[k] : name)
  }
  return ass.replace(STYLE_FONT, swap).replace(FN_TAG, swap)
}

const STYLE_FONT = /^(Style:[^,]*,)([^,]*)/gm
const FN_TAG = /(\\fn)([^\\}]*)/g
const key = (name: string) => name.trim().replace(/^@/, '').toLowerCase()
