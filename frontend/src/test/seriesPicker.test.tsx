import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SeriesPicker } from '../components/RenameOptions'
import { api, type Media } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const media = (id: number, title: string) => ({ id, title: { romaji: title, english: '' } }) as unknown as Media

describe('SeriesPicker', () => {
  it('ignores an overtaken answer and says when the search failed', async () => {
    vi.useFakeTimers()
    const resolvers: Record<string, (m: Media[]) => void> = {}
    let fail = false
    vi.spyOn(api, 'get').mockImplementation(
      (u: string) =>
        new Promise((resolve, reject) => {
          if (fail) return reject(new Error('rate limited'))
          resolvers[decodeURIComponent(u.split('q=')[1])] = resolve as (m: Media[]) => void
        }),
    )
    render(<SeriesPicker provider="tvdb" initialQuery="nar" onPick={() => {}} onClose={() => {}} />)
    await act(() => vi.advanceTimersByTimeAsync(350))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'naruto' } })
    await act(() => vi.advanceTimersByTimeAsync(350))
    // the newer search answers first, the older one limps in afterwards
    await act(async () => resolvers['naruto']([media(2, 'Naruto')]))
    await act(async () => resolvers['nar']([media(1, 'Narutaru')]))
    expect(screen.getByText('Naruto')).toBeTruthy()
    expect(screen.queryByText('Narutaru')).toBeNull()
    // an outage is an error, not "no results"
    fail = true
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bleach' } })
    await act(() => vi.advanceTimersByTimeAsync(350))
    expect(screen.getByRole('alert').textContent).toBe('rate limited')
  })
})
