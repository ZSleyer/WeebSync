import { expect, test } from 'vitest'
import { renameFamilies, scaleFonts, scriptFamilies } from '../pages/assFonts'

const ass = [
  'Style: Default,Calibri,26,&H00FFFFFF',
  'Style: Sign,@MS Gothic,19,&H00200960',
  'Dialogue: 0,0:00:13.73,0:00:19.45,Sign,,0,0,0,,{\\fnGeorgia\\i1}Die {\\fnTimes New Roman\\b1}Apothekerin{\\fn}!',
  'Dialogue: 0,0:00:20.00,0:00:21.00,Default,,0,0,0,,{\\fngeorgia}x',
].join('\r\n')

test('the families of the styles and the \\fn overrides, once each', () => {
  expect(scriptFamilies(ass)).toEqual(['calibri', 'ms gothic', 'georgia', 'times new roman'])
})

test('a renamed family in styles and overrides, the rest untouched', () => {
  const out = renameFamilies(ass, { calibri: 'Carlito', georgia: 'Gelasio', 'ms gothic': 'Noto Sans JP' })
  expect(out).toContain('Style: Default,Carlito,26')
  expect(out).toContain('Style: Sign,@Noto Sans JP,19')
  expect(out).toContain('{\\fnGelasio\\i1}Die {\\fnTimes New Roman\\b1}Apothekerin{\\fn}!')
  expect(out).toContain('{\\fnGelasio}x')
})

const script = [
  '[Script Info]',
  'PlayResY: 360',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, MarginV',
  'Style: Default,Calibri,26,&H00FFFFFF,20',
  'Style: Sign,Arial,19.5,&H00200960,10',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Text',
  'Dialogue: 0,0:00:01.00,0:00:02.00,Sign,{\\pos(320,40)\\fs40\\fscx120}Shop',
].join('\r\n')

test('scaling the text sizes styles and \\fs overrides, never positions or scale tags', () => {
  const out = scaleFonts(script, 1.25)
  expect(out).toContain('Style: Default,Calibri,32.5,&H00FFFFFF,20')
  expect(out).toContain('Style: Sign,Arial,24.38,&H00200960,10')
  expect(out).toContain('{\\pos(320,40)\\fs50\\fscx120}Shop')
  expect(out).toContain('PlayResY: 360')
  expect(out.split('\r\n')).toHaveLength(script.split('\r\n').length)
})

test('the size column follows the Format line', () => {
  const odd = '[V4+ Styles]\nFormat: Name, Fontsize, Fontname\nStyle: A,20,Arial'
  expect(scaleFonts(odd, 0.8)).toContain('Style: A,16,Arial')
})

test('a factor of one leaves the script as it is', () => {
  expect(scaleFonts(script, 1)).toBe(script)
})
