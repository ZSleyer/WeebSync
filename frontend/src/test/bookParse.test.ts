import { describe, expect, it } from 'vitest'
import {
  decodeText,
  epubRootfile,
  epubSpine,
  epubToc,
  odsSheets,
  resolveIn,
  xlsxRows,
  xlsxSheetParts,
  xlsxStrings,
} from '../components/bookParse'

describe('decodeText', () => {
  it('reads UTF-8 first', () => {
    expect(decodeText(new TextEncoder().encode('Grüße ░'), 'a.txt')).toBe('Grüße ░')
  })
  it('draws NFO art in CP437', () => {
    expect(decodeText(new Uint8Array([0xb0, 0xdb, 0x41, 0xc9, 0xcd]), 'release.nfo')).toBe('░█A╔═')
  })
  it('falls back to windows-1252 for other text', () => {
    expect(decodeText(new Uint8Array([0x47, 0x72, 0xfc, 0xdf, 0x65]), 'notes.txt')).toBe('Grüße')
  })
})

describe('epub', () => {
  it('finds the package', () => {
    const xml = `<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    expect(epubRootfile(xml)).toBe('OEBPS/content.opf')
  })
  it('reads the spine in order, skips non-linear items', () => {
    const opf = `<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Book</dc:title></metadata>
      <manifest>
        <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
        <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
        <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
        <item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="cover" linear="no"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>`
    const b = epubSpine(opf, 'OEBPS/content.opf')
    expect(b.title).toBe('Book')
    expect(b.chapters.map((c) => c.href)).toEqual(['OEBPS/text/ch1.xhtml', 'OEBPS/text/ch2.xhtml'])
    expect(b.nav).toBe('OEBPS/nav.xhtml')
  })
  it('labels chapters from the contents', () => {
    const nav = `<html><body><nav><ol><li><a href="text/ch1.xhtml#start">Prolog</a></li></ol></nav></body></html>`
    expect(epubToc(nav, 'OEBPS/nav.xhtml').get('OEBPS/text/ch1.xhtml')).toBe('Prolog')
    const ncx = `<ncx><navMap><navPoint><navLabel><text>Kapitel 1</text></navLabel><content src="../t/c1.html"/></navPoint></navMap></ncx>`
    expect(epubToc(ncx, 'OPS/toc/toc.ncx').get('OPS/t/c1.html')).toBe('Kapitel 1')
  })
  it('resolves relative paths', () => {
    expect(resolveIn('a/b/c.xhtml', '../img/x%20y.png')).toBe('a/img/x y.png')
  })
})

describe('spreadsheets', () => {
  it('reads ods with repeated cells and drops the styled emptiness', () => {
    const xml = `<office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x"><office:body><office:spreadsheet>
      <table:table table:name="Discs">
        <table:table-row><table:table-cell><text:p>Titel</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"><text:p>-</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16000"/></table:table-row>
        <table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="16000"/></table:table-row>
      </table:table></office:spreadsheet></office:body></office:document-content>`
    expect(odsSheets(xml)).toEqual([{ name: 'Discs', rows: [['Titel', '-', '-']] }])
  })
  it('reads xlsx strings, numbers and gaps', () => {
    const wb = `<workbook xmlns:r="r"><sheets><sheet name="Eins" sheetId="1" r:id="rId1"/></sheets></workbook>`
    const rels = `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`
    expect(xlsxSheetParts(wb, rels)).toEqual([{ name: 'Eins', path: 'xl/worksheets/sheet1.xml' }])
    const strings = xlsxStrings(`<sst><si><t>Name</t></si><si><r><t>Fa</t></r><r><t>rbe</t></r></si></sst>`)
    const sheet = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
      <row r="3"><c r="B3"><v>42</v></c><c r="C3" t="b"><v>1</v></c></row>
    </sheetData></worksheet>`
    expect(xlsxRows(sheet, strings)).toEqual([['Name', '', 'Farbe'], [], ['', '42', 'TRUE']])
  })
})
