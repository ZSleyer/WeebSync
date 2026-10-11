import { expect, test } from 'vitest'
import { renameFamilies, scriptFamilies } from '../pages/assFonts'

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
