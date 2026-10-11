// The parsing behind the viewers: text in whatever encoding a release used,
// the reading order of an EPUB, the cells of a spreadsheet. Pure functions
// over strings and bytes, so they are tested without a server.

// The upper half of code page 437, the DOS character set NFO art is drawn in.
// TextDecoder knows no CP437, and windows-1252 turns the box drawing into
// accented letters.
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

/**
 * The bytes without a UTF-8 sequence that a cut left incomplete at the end:
 * a range read stops at a byte count, not at a character, and the strict
 * decoder below would refuse the whole text for that one broken character.
 */
export function trimUtf8Tail(bytes: Uint8Array): Uint8Array {
  // the last lead byte sits at most three continuation bytes (10xxxxxx) back
  let i = bytes.length - 1
  while (i >= 0 && i > bytes.length - 4 && (bytes[i] & 0xc0) === 0x80) i--
  if (i < 0) return bytes
  const lead = bytes[i]
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return i + need > bytes.length ? bytes.subarray(0, i) : bytes
}

/**
 * Text from bytes: UTF-8 when the bytes are valid UTF-8, otherwise CP437 for
 * an .nfo/.diz (scene art) and windows-1252 for anything else. `cut` says the
 * bytes are the start of a longer file, which may end mid-character.
 */
export function decodeText(bytes: Uint8Array, name: string, cut = false): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(cut ? trimUtf8Tail(bytes) : bytes)
  } catch {
    if (/\.(nfo|diz)$/i.test(name)) {
      let out = ''
      for (const b of bytes) out += b < 128 ? String.fromCharCode(b) : CP437_HIGH[b - 128]
      return out
    }
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

const parseXml = (text: string) => new DOMParser().parseFromString(text, 'application/xml')

/** Resolves an href inside a book against the file that names it. */
export function resolveIn(from: string, href: string): string {
  const parts = from.split('/').slice(0, -1)
  for (const seg of decodeURIComponent(href.split('#')[0]).split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

/** The OPF package path from META-INF/container.xml. */
export function epubRootfile(containerXml: string): string {
  return parseXml(containerXml).getElementsByTagName('rootfile')[0]?.getAttribute('full-path') ?? ''
}

export interface EpubChapter {
  href: string // path inside the book
  label: string
}

export interface EpubBook {
  title: string
  chapters: EpubChapter[]
  /** the navigation document to read the table of contents from, if any */
  nav: string
  ncx: string
}

/** The reading order (spine) of an EPUB package, chapter paths inside the book. */
export function epubSpine(opfXml: string, opfPath: string): EpubBook {
  const doc = parseXml(opfXml)
  const items = new Map<string, { href: string; props: string; type: string }>()
  for (const it of doc.getElementsByTagName('item')) {
    items.set(it.getAttribute('id') ?? '', {
      href: resolveIn(opfPath, it.getAttribute('href') ?? ''),
      props: it.getAttribute('properties') ?? '',
      type: it.getAttribute('media-type') ?? '',
    })
  }
  const chapters: EpubChapter[] = []
  for (const ref of doc.getElementsByTagName('itemref')) {
    if (ref.getAttribute('linear') === 'no') continue
    const it = items.get(ref.getAttribute('idref') ?? '')
    if (it) chapters.push({ href: it.href, label: '' })
  }
  let nav = '',
    ncx = ''
  for (const it of items.values()) {
    if (it.props.split(/\s+/).includes('nav')) nav = it.href
    if (it.type === 'application/x-dtbncx+xml') ncx = it.href
  }
  const title = doc.getElementsByTagName('dc:title')[0]?.textContent?.trim() ?? ''
  return { title, chapters, nav, ncx }
}

/**
 * Chapter labels from the table of contents: the EPUB 3 navigation document
 * or the EPUB 2 NCX, keyed by chapter path. A chapter the contents does not
 * name keeps no label; the reader numbers it.
 */
export function epubToc(xml: string, tocPath: string): Map<string, string> {
  const doc = parseXml(xml)
  const out = new Map<string, string>()
  const add = (href: string | null, label: string | null | undefined) => {
    const key = href ? resolveIn(tocPath, href) : ''
    const text = label?.replace(/\s+/g, ' ').trim()
    if (key && text && !out.has(key)) out.set(key, text)
  }
  for (const a of doc.getElementsByTagName('a')) add(a.getAttribute('href'), a.textContent)
  for (const p of doc.getElementsByTagName('navPoint')) {
    add(
      p.getElementsByTagName('content')[0]?.getAttribute('src') ?? null,
      p.getElementsByTagName('text')[0]?.textContent,
    )
  }
  return out
}

export interface Sheet {
  name: string
  rows: string[][]
}

// a spreadsheet styles whole columns and rows out to the format's limit; the
// viewer shows what has content and stops well before that
const MAX_ROWS = 5000
const MAX_COLS = 200

const trimRows = (rows: string[][]) => {
  for (const r of rows) while (r.length && r[r.length - 1] === '') r.pop()
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop()
  return rows
}

/** The sheets of an OpenDocument spreadsheet's content.xml. */
export function odsSheets(contentXml: string): Sheet[] {
  const doc = parseXml(contentXml)
  const sheets: Sheet[] = []
  for (const table of doc.getElementsByTagName('table:table')) {
    const rows: string[][] = []
    for (const row of table.getElementsByTagName('table:table-row')) {
      const cells: string[] = []
      for (const c of row.children) {
        if (c.tagName !== 'table:table-cell' && c.tagName !== 'table:covered-table-cell') continue
        const text = [...c.getElementsByTagName('text:p')].map((p) => p.textContent ?? '').join('\n')
        const n = Math.min(Number(c.getAttribute('table:number-columns-repeated') ?? 1), MAX_COLS - cells.length)
        for (let i = 0; i < n; i++) cells.push(text)
      }
      const n = Math.min(Number(row.getAttribute('table:number-rows-repeated') ?? 1), MAX_ROWS - rows.length)
      for (let i = 0; i < n; i++) rows.push([...cells])
      if (rows.length >= MAX_ROWS) break
    }
    sheets.push({ name: table.getAttribute('table:name') ?? '', rows: trimRows(rows) })
  }
  return sheets
}

/** The sheet names and their part paths from an xlsx workbook and its relations. */
export function xlsxSheetParts(workbookXml: string, relsXml: string): { name: string; path: string }[] {
  const rels = new Map<string, string>()
  for (const r of parseXml(relsXml).getElementsByTagName('Relationship')) {
    const target = r.getAttribute('Target') ?? ''
    rels.set(
      r.getAttribute('Id') ?? '',
      target.startsWith('/') ? target.slice(1) : resolveIn('xl/workbook.xml', target),
    )
  }
  return [...parseXml(workbookXml).getElementsByTagName('sheet')].map((s) => ({
    name: s.getAttribute('name') ?? '',
    path: rels.get(s.getAttribute('r:id') ?? '') ?? '',
  }))
}

/** The shared string table of an xlsx file. */
export function xlsxStrings(sharedXml: string): string[] {
  return [...parseXml(sharedXml).getElementsByTagName('si')].map((si) =>
    [...si.getElementsByTagName('t')].map((t) => t.textContent ?? '').join(''),
  )
}

const colIndex = (ref: string) => {
  let n = 0
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64
  return n - 1
}

/** The cell values of one xlsx sheet, as text. */
export function xlsxRows(sheetXml: string, strings: string[]): string[][] {
  const rows: string[][] = []
  for (const row of parseXml(sheetXml).getElementsByTagName('row')) {
    const at = Number(row.getAttribute('r') ?? rows.length + 1) - 1
    if (at >= MAX_ROWS) break
    const cells: string[] = []
    for (const c of row.getElementsByTagName('c')) {
      const col = colIndex(c.getAttribute('r') ?? '')
      if (col < 0 || col >= MAX_COLS) continue
      const type = c.getAttribute('t')
      const v = c.getElementsByTagName('v')[0]?.textContent ?? ''
      cells[col] =
        type === 's'
          ? (strings[Number(v)] ?? '')
          : type === 'inlineStr'
            ? [...c.getElementsByTagName('t')].map((t) => t.textContent ?? '').join('')
            : type === 'b'
              ? v === '1'
                ? 'TRUE'
                : 'FALSE'
              : v
    }
    while (rows.length < at) rows.push([])
    rows[at] = Array.from(cells, (x) => x ?? '')
  }
  return trimRows(rows)
}
