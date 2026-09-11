import { describe, expect, it } from 'vitest'
import { upcomingAirings } from '../airings'
import type { Watch } from '../api'

const watch = (id: number, airings: { at: number; episode: number; episodeAbs?: number }[]) => ({ id, airings }) as unknown as Watch

describe('upcomingAirings', () => {
  const now = 1_000_000 * 1000
  const ws = [watch(1, [{ at: 1_000_100, episode: 3 }, { at: 999_000, episode: 2 }]), watch(2, [{ at: 1_000_050, episode: 12, episodeAbs: 1112 }]), watch(3, [])]

  it('flattens every future release across the watches, soonest first', () => {
    const list = upcomingAirings(ws, now)
    expect(list.map((e) => [e.watch.id, e.episode])).toEqual([
      [2, 12],
      [1, 3],
    ])
    expect(list[0].episodeAbs).toBe(1112)
  })

  it('caps the horizon in days when asked', () => {
    const far = watch(4, [{ at: 1_000_000 + 8 * 86_400, episode: 1 }])
    expect(upcomingAirings([...ws, far], now, 7).map((e) => e.watch.id)).toEqual([2, 1])
    expect(upcomingAirings([...ws, far], now).map((e) => e.watch.id)).toEqual([2, 1, 4])
  })

  it('handles watches without a schedule', () => {
    expect(upcomingAirings([{ id: 9 } as unknown as Watch], now)).toEqual([])
  })
})

describe('week helpers', () => {
  it('finds the week start for the locale first day', async () => {
    const { startOfWeek, dayKey, addDays } = await import('../airings')
    const thu = new Date(2026, 8, 17, 15, 30) // Thursday
    expect(dayKey(startOfWeek(thu, 1))).toBe('2026-09-14')
    expect(dayKey(startOfWeek(thu, 7))).toBe('2026-09-13')
    expect(startOfWeek(thu, 1).getHours()).toBe(0)
    // a Monday is its own week start
    expect(dayKey(startOfWeek(new Date(2026, 8, 14, 1), 1))).toBe('2026-09-14')
    expect(dayKey(addDays(startOfWeek(thu, 1), 7))).toBe('2026-09-21')
  })
})
