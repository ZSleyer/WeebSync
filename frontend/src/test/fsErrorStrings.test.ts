import { describe, expect, it } from 'vitest'
import { FS_ERROR_CODES } from '../api'
import de from '../locales/de.json'
import en from '../locales/en.json'

// FsErrorNote looks a code up as fsError.<code>.what / .fix. A code the backend
// classifies but a locale never got renders as the bare key, so the one row
// that was supposed to explain the failure shows "fsError.rename_failed.what".
describe('fsError strings', () => {
  for (const [name, bundle] of [
    ['de', de],
    ['en', en],
  ] as const) {
    it(`${name} explains every classified code`, () => {
      const fsError = bundle.fsError as Record<string, { what?: string; fix?: string }>
      for (const code of FS_ERROR_CODES) {
        expect(fsError[code]?.what, `${name}: fsError.${code}.what`).toBeTruthy()
        expect(fsError[code]?.fix, `${name}: fsError.${code}.fix`).toBeTruthy()
      }
    })
  }
})
