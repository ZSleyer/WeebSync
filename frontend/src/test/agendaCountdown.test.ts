import { describe, expect, it } from 'vitest'
import { airingState } from '../pages/today/Agenda'

const t = (k: string, o?: Record<string, unknown>) => `${k}:${JSON.stringify(o)}`

describe('airingState', () => {
  it('counts hours for a release later today, even beyond 20 hours', () => {
    const now = new Date(2026, 9, 14, 0, 10).getTime()
    const at = new Date(2026, 9, 14, 23, 50).getTime()
    expect(airingState(t, at, false, now).text).toBe('today.inHours:{"h":23,"mm":"40"}')
  })

  it('counts days once the release is on another day', () => {
    const now = new Date(2026, 9, 14, 0, 10).getTime()
    const at = new Date(2026, 9, 16, 12, 0).getTime()
    expect(airingState(t, at, false, now).text).toBe('today.inDays:{"count":2}')
  })
})
