// The words of an ASS script as WebVTT, for the one place libass cannot draw:
// the browser's own picture-in-picture window shows the video element and its
// text tracks, never the canvas over it. Only the text and its times come
// across; styles, positions and fonts stay behind.

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

// h:mm:ss.cc, the centiseconds libass reads; NaN for anything else
function seconds(t: string): number {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(t)
  if (!m) return NaN
  const frac = m[4] ? Number(m[4]) / 10 ** m[4].length : 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac
}

function stamp(s: number): string {
  const ms = Math.round(s * 1000)
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}

// the text of an event without its override blocks; what a drawing ({\p1}
// up to {\p0}) holds are path commands, not words
function plain(text: string): string {
  let out = ''
  let drawing = false
  for (const part of text.split(/(\{[^}]*\})/)) {
    if (part.startsWith('{') && part.endsWith('}')) {
      for (const m of part.matchAll(/\\p(\d+)/g)) drawing = m[1] !== '0'
      continue
    }
    if (!drawing) out += part
  }
  return (
    out
      // \N breaks the line; \n only where the script asks for it (WrapStyle
      // 2), libass's default draws it as a space
      .replace(/\\N/g, '\n')
      .replace(/\\n/g, ' ')
      .replace(/\\h/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n')
      // WebVTT reads these as markup
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  )
}

export function assToVtt(ass: string): string {
  let events = false
  let cols: string[] = []
  const cues: { start: number; end: number; text: string }[] = []
  const seen = new Set<string>()
  for (const raw of ass.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      events = line.toLowerCase() === '[events]'
      continue
    }
    if (!events) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const rest = line.slice(colon + 1)
    if (key === 'format') {
      cols = rest.split(',').map((c) => c.trim().toLowerCase())
      continue
    }
    if (key !== 'dialogue' || !cols.length) continue
    // the text is the last column and keeps its commas
    const fields = rest.split(',')
    const values = [...fields.slice(0, cols.length - 1), fields.slice(cols.length - 1).join(',')]
    const at = (name: string) => values[cols.indexOf(name)] ?? ''
    const start = seconds(at('start'))
    const end = seconds(at('end'))
    const text = plain(at('text').replace(/^\s+/, ''))
    if (!(end > start) || !text) continue
    // a typeset draws one line on several layers (border, fill): once is enough
    const id = `${start}|${end}|${text}`
    if (seen.has(id)) continue
    seen.add(id)
    cues.push({ start, end, text })
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end)
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n\n`).join('')}`
}
