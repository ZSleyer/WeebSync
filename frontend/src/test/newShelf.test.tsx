import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import type { Download, DownloadMeta, Watch } from '../api'
import { NewShelf } from '../pages/today/NewShelf'

const open = vi.fn()
vi.mock('../components/SeriesModal', () => ({ useSeriesModal: () => ({ open }) }))
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({
      t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k),
      i18n: { language: 'en' },
    }) as never,
}))

const NOW = Date.parse('2026-10-14T12:00:00Z')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  open.mockReset()
})

const dl = (item: Record<string, unknown>): { d: Download; meta: DownloadMeta } => ({
  d: {
    id: 1,
    serverId: 1,
    remotePath: '/a/Show - 03.mkv',
    localPath: '/media/Show/Show - 03.mkv',
    status: 'done',
    finishedAt: '2026-10-13 10:00:00',
  } as Download,
  meta: { groups: { g1: { title: 'Frieren' } }, items: { '1': { g: 'g1', episode: 3, season: 1, ...item } } } as never,
})

describe('the "new here" tiles', () => {
  it.each([
    ['with chips', { res: 1080, dub: ['de'] }],
    ['without chips', {}],
  ])('name the series, episode and day for a screen reader (%s)', (_n, item) => {
    const { d, meta } = dl(item)
    render(
      <MemoryRouter>
        <NewShelf downloads={[d]} meta={meta} watches={[]} loading={false} />
      </MemoryRouter>,
    )
    const name = screen.getByRole('button', { name: /Frieren/ }).getAttribute('aria-label')
    expect(name).toContain('Frieren')
    expect(name).toContain('today.epSeason')
    expect(name).toContain('dash.landed')
  })

  it('opens the series at its title, not at the episode that landed', () => {
    const { d, meta } = dl({})
    const media = { id: 154587, title: { romaji: 'Frieren' } }
    const watch = { id: 7, mediaSource: 'anilist', media } as unknown as Watch
    meta.groups.g1 = { ...meta.groups.g1, watchId: 7 } as never
    render(
      <MemoryRouter>
        <NewShelf downloads={[d]} meta={meta} watches={[watch]} loading={false} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Frieren/ }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0][0]).toEqual({ source: 'anilist', id: 154587, media, watchId: 7, title: undefined })
  })
})
