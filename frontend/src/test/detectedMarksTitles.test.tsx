import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { DetectedMarks, titleSummary } from '../pages/settings/DetectedMarks'
import { api } from '../api'

function tr(k: string, o?: { count?: number }) {
  return o?.count === undefined ? k : `${o.count} ${k.replace('servers.detected', '')}`
}

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: tr, i18n: { language: 'en' } }) as never,
}))

const titles = (anilist: number, tvdb: number, tmdb: number, noMatch: number, pending: number) => ({
  total: anilist + tvdb + tmdb + noMatch + pending,
  matched: { anilist, tvdb, tmdb },
  noMatch,
  pending,
})

afterEach(() => vi.restoreAllMocks())

describe('titleSummary', () => {
  it('lists providers with titles and the leftovers', () => {
    expect(titleSummary(tr as never, titles(300, 60, 10, 11, 5))).toBe(
      '370 Matched: AniList 300 · TVDB 60 · TMDB 10 · 11 NoMatch · 5 Pending',
    )
    expect(titleSummary(tr as never, titles(0, 2, 0, 0, 0))).toBe('2 Matched: TVDB 2')
    expect(titleSummary(tr as never, titles(0, 0, 0, 0, 4))).toBe('4 Pending')
  })
  it('says nothing before the index has read the folder', () => {
    expect(titleSummary(tr as never, titles(0, 0, 0, 0, 0))).toBe('')
  })
})

describe('DetectedMarks', () => {
  it('shows the line under the row', async () => {
    const mark = { serverId: 1, serverName: 'srv', kind: 'auto', detectedAt: 1, unseen: false }
    vi.spyOn(api, 'get').mockResolvedValue({
      unseen: 0,
      items: [
        { ...mark, path: '/a/Anime', name: 'Anime', titles: titles(3, 1, 0, 1, 0) },
        { ...mark, path: '/a/Empty', name: 'Empty', titles: titles(0, 0, 0, 0, 0) },
      ],
    } as never)
    const router = createMemoryRouter([{ path: '/', element: <DetectedMarks /> }])
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByText('4 Matched: AniList 3 · TVDB 1 · 1 NoMatch')).toBeTruthy())
    expect(screen.queryAllByText(/Matched/).length).toBe(1)
  })
})
