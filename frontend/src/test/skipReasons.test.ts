import { describe, expect, it } from 'vitest'
import type { Schemas } from '../api.gen'
import de from '../locales/de.json'
import en from '../locales/en.json'

type Reason = Schemas['transfer.Skip']['reason']

// Every reason the backend can give for leaving a file on the server. A Record
// over the generated union: a reason added to the API and missing here fails
// the type check, so a new one cannot slip through unexplained.
const REASONS: Record<Reason, true> = {
  outside_roots: true,
  language: true,
  worse_variant: true,
  owned: true,
  uploading: true,
  queued: true,
  blocked: true,
  foreign_target: true,
}

// The auto-sync explanation shows the last check's skips as explain.skips.<r>
// and the rules page lists explain.rules.skip.<r>; a reason without its text
// shows as the bare key.
describe('skip reasons', () => {
  for (const [name, bundle] of [
    ['de', de],
    ['en', en],
  ] as const) {
    it(`${name} explains every reason`, () => {
      const skips = bundle.explain.skips as Record<string, string>
      const rules = bundle.explain.rules.skip as Record<string, { head?: string; body?: string }>
      for (const r of Object.keys(REASONS)) {
        expect(skips[r], `${name}: explain.skips.${r}`).toBeTruthy()
        expect(rules[r]?.head, `${name}: explain.rules.skip.${r}.head`).toBeTruthy()
      }
    })
  }
})
