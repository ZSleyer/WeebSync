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

// scaleFonts sizes a script's text by `factor`: every style's font size and
// every \fs override. The script's own layout stays, positions and margins
// are untouched, so a sign keeps its place and a line only grows or shrinks.
export function scaleFonts(ass: string, factor: number): string {
  if (!(factor > 0) || factor === 1) return ass
  const size = (n: string) => String(Math.round(Number(n) * factor * 100) / 100)
  let styles = false
  // the column of the size: named by the section's Format line, third by default
  let col = 2
  return ass
    .split('\n')
    .map((line) => {
      const head = line.trimStart()
      if (head.startsWith('[')) {
        styles = /^\[v4\+? styles\]/i.test(head)
        return line
      }
      if (styles && /^format:/i.test(head)) {
        const at = head
          .slice(head.indexOf(':') + 1)
          .split(',')
          .findIndex((f) => f.trim().toLowerCase() === 'fontsize')
        if (at >= 0) col = at
        return line
      }
      if (styles && /^style:/i.test(head)) {
        const colon = line.indexOf(':')
        const fields = line.slice(colon + 1).split(',')
        const v = fields[col]
        if (v !== undefined && v.trim() !== '' && !Number.isNaN(Number(v))) {
          const pad = v.match(/^\s*/)?.[0] ?? ''
          fields[col] = pad + size(v.trim())
        }
        return line.slice(0, colon + 1) + fields.join(',')
      }
      if (/^dialogue:/i.test(head)) return line.replace(FS_TAG, (_, n: string) => `\\fs${size(n)}`)
      return line
    })
    .join('\n')
}

const FS_TAG = /\\fs(\d+(?:\.\d+)?)/g
const STYLE_FONT = /^(Style:[^,]*,)([^,]*)/gm
const FN_TAG = /(\\fn)([^\\}]*)/g
const key = (name: string) => name.trim().replace(/^@/, '').toLowerCase()
