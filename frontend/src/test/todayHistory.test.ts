import { expect, test } from 'vitest'
import type { Download, Watch } from '../api'
import { daysAgo, filterHistory, groupByDay, histKind, langChip, weekSummary } from '../pages/today/history'
import { buildNeeds } from '../pages/today/needs'

const dl = (id: number, status: Download['status'], finishedAt: string, extra: Partial<Download> = {}): Download =>
  ({
    id,
    userId: 1,
    serverId: 1,
    remotePath: `/a/Show ${id}.mkv`,
    localPath: `/media/Show/Show ${id}.mkv`,
    size: 1_000,
    transferred: 1_000,
    status,
    rateLimit: 0,
    queuePos: 0,
    createdAt: '',
    finishedAt,
    ...extra,
  }) as Download

// a fixed local noon, so day boundaries do not depend on when the test runs
const now = new Date(2026, 9, 14, 12, 0).getTime()
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const hoursAgo = (h: number) => utc(now - h * 3_600_000)

test('the kind of a finished download', () => {
  expect(histKind({ status: 'done' })).toBe('done')
  expect(histKind({ status: 'done', replaceOld: true })).toBe('up')
  expect(histKind({ status: 'error' })).toBe('fail')
  expect(histKind({ status: 'canceled' })).toBeNull()
  expect(histKind({ status: 'running' })).toBeNull()
})

test('grouped by day, newest first', () => {
  const list = [
    dl(1, 'done', hoursAgo(30)),
    dl(2, 'done', hoursAgo(1)),
    dl(3, 'error', hoursAgo(2)),
    dl(4, 'done', hoursAgo(80)),
  ]
  const days = groupByDay(list, now)
  expect(days.map((d) => d.ago)).toEqual([0, 1, 3])
  expect(days[0].items.map((d) => d.id)).toEqual([2, 3])
  expect(daysAgo(now - 13 * 3_600_000, now)).toBe(1) // 23:00 yesterday
})

test('filter and search', () => {
  const list = [
    dl(1, 'done', hoursAgo(1)),
    dl(2, 'done', hoursAgo(1), { replaceOld: true }),
    dl(3, 'error', hoursAgo(1)),
    dl(4, 'canceled', hoursAgo(1)),
  ]
  const title = (d: Download) => (d.id === 2 ? 'Frieren' : 'One Piece')
  expect(filterHistory(list, 'all', '', title).map((d) => d.id)).toEqual([1, 2, 3])
  expect(filterHistory(list, 'up', '', title).map((d) => d.id)).toEqual([2])
  expect(filterHistory(list, 'fail', '', title).map((d) => d.id)).toEqual([3])
  expect(filterHistory(list, 'all', 'frie', title).map((d) => d.id)).toEqual([2])
  expect(filterHistory(list, 'all', 'show 3', title).map((d) => d.id)).toEqual([3])
})

test('the week in numbers', () => {
  const list = [
    dl(1, 'done', hoursAgo(1), { size: 100 }),
    dl(2, 'done', hoursAgo(20), { size: 50, replaceOld: true }),
    dl(3, 'error', hoursAgo(2)),
    dl(4, 'done', hoursAgo(24 * 9), { size: 999 }),
  ]
  expect(weekSummary(list, now)).toEqual({ episodes: 2, bytes: 150, upgrades: 1, failed: 1 })
})

test('language chips', () => {
  expect(langChip('Ger')).toBe('DE')
  expect(langChip('Jap')).toBe('JA')
  expect(langChip('Xyz')).toBe('XYZ')
})

const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k)

test('needs: recent failures, watches that wait, new folders', () => {
  const downloads = [
    dl(1, 'error', hoursAgo(2), { error: 'boom' }),
    dl(2, 'error', hoursAgo(24 * 10)),
    dl(3, 'done', hoursAgo(1)),
  ]
  const watches = [
    { id: 7, remotePath: '/a/Show', attention: ['checkFailed'] } as unknown as Watch,
    { id: 8, remotePath: '/a/Calm', attention: [] } as unknown as Watch,
  ]
  const hints = [{ serverId: 1, serverName: 'srv', path: '/a/New S2', name: 'New S2', sibling: 'New', kind: 'anime' }]
  const needs = buildNeeds(t, { downloads, watches, hints: hints as never, now })
  expect(needs.map((n) => n.key)).toEqual(['dl-1', 'w-7', 'h-1-/a/New S2'])
  expect(needs[0].sub).toBe('boom')
  expect(needs[1].why).toBe(true)
  expect(needs[2].sub).toContain('remote.scopeAnime')
})
