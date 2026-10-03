import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import type { Media } from '../api'
import { expectedOf, missingOf } from '../components/UpcomingSeason'

// echo key and params, so the test reads which branch was taken
const t = ((k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k)) as unknown as TFunction
const now = new Date(2026, 9, 20, 12).getTime()
const media = (p: Partial<Media>): Media => ({ status: 'NOT_YET_RELEASED', ...p }) as Media

describe('expectedOf', () => {
  it('counts down to an announced slot', () => {
    const e = expectedOf(t, media({ nextAiringEpisode: { airingAt: now / 1000 + 3 * 86400, episode: 1 } }), 'de', now)
    expect(e.label).toMatch(/^watch\.inDaysH/)
    expect(e.tone).toBe('accent')
  })
  it('reads a passed slot or a running series as a late upload', () => {
    expect(
      expectedOf(t, media({ nextAiringEpisode: { airingAt: now / 1000 - 60, episode: 1 } }), 'de', now).label,
    ).toBe('upcoming.uploadPending')
    expect(expectedOf(t, media({ status: 'RELEASING' }), 'de', now).tone).toBe('warn')
    expect(expectedOf(t, media({ startDate: 20261018 }), 'de', now).label).toBe('upcoming.uploadPending')
  })
  it('keeps date-only starts at their precision', () => {
    expect(expectedOf(t, media({ startDate: 20261102 }), 'en', now).label).toMatch(/^upcoming\.expected/)
    expect(expectedOf(t, media({ startDate: 20261100 }), 'en', now).label).toContain('November')
    expect(expectedOf(t, media({}), 'en', now).label).toBe('upcoming.undated')
  })
  it('orders dated before month-only before undated', () => {
    const at = (p: Partial<Media>) => expectedOf(t, media(p), 'en', now).at
    expect(at({ startDate: 20261130 })).toBeLessThan(at({ startDate: 20261100 }) + 1)
    expect(at({ startDate: 20261100 })).toBeLessThan(at({}))
  })
})

describe('missingOf', () => {
  it('names the start when AniList knows the day', () => {
    expect(missingOf(t, media({ startDate: 20261003 }), 'en').label).toMatch(/^upcoming\.missingSince/)
    expect(missingOf(t, media({ startDate: 20261000 }), 'en').label).toBe('upcoming.missingBadge')
  })
})
