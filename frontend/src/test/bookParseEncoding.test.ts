import { describe, expect, it } from 'vitest'
import { decodeText, resolveIn, xlsxRows, xlsxStrings } from '../components/bookParse'

const utf16 = (s: string, le: boolean) =>
  new Uint8Array(
    [...s].flatMap((c) => {
      const u = c.charCodeAt(0)
      return le ? [u & 0xff, u >> 8] : [u >> 8, u & 0xff]
    }),
  )

describe('decodeText by byte order mark', () => {
  it('decodes UTF-16 LE and BE', () => {
    const le = new Uint8Array([0xff, 0xfe, ...utf16('EAC ログ', true)])
    const be = new Uint8Array([0xfe, 0xff, ...utf16('EAC ログ', false)])
    expect(decodeText(le, 'a.log')).toBe('EAC ログ')
    expect(decodeText(be, 'a.cue')).toBe('EAC ログ')
  })
  it('drops a half code unit at a range cut', () => {
    const le = new Uint8Array([0xff, 0xfe, ...utf16('EAC ログ', true)])
    expect(decodeText(le.slice(0, le.length - 1), 'a.log', true)).toBe('EAC ロ')
  })
})

describe('resolveIn', () => {
  it('survives a stray percent sign and still decodes escapes', () => {
    expect(resolveIn('OEBPS/content.opf', 'Kapitel 50%.xhtml')).toBe('OEBPS/Kapitel 50%.xhtml')
    expect(resolveIn('OEBPS/content.opf', 'a%20b.xhtml')).toBe('OEBPS/a b.xhtml')
  })
})

describe('xlsx phonetic runs', () => {
  it('leaves furigana out of shared and inline strings', () => {
    const s = xlsxStrings(
      `<sst><si><r><t>漢字</t></r><rPh sb="0" eb="2"><t>カンジ</t></rPh><phoneticPr fontId="1"/></si><si><t>x</t><rPh><t>y</t></rPh></si></sst>`,
    )
    expect(s).toEqual(['漢字', 'x'])
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>漢字</t><rPh><t>カンジ</t></rPh></is></c></row></sheetData></worksheet>`
    expect(xlsxRows(sheet, [])).toEqual([['漢字']])
  })
})
