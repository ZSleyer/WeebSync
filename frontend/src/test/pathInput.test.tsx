import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import PathInput from '../components/PathInput'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

afterEach(() => vi.restoreAllMocks())

describe('PathInput', () => {
  it('owns only options inside its listbox (APG listbox pattern)', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([
      { name: 'Alpha', isDir: true },
      { name: 'Beta', isDir: true },
    ])
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PathInput value="" onChange={() => {}} onCommit={() => {}} fetchPath={(p) => `/x?${p}`} queryKey={['t']} />
      </QueryClientProvider>,
    )
    fireEvent.focus(screen.getByRole('combobox'))
    const list = await screen.findByRole('listbox')
    expect(screen.getAllByRole('option')).toHaveLength(2)
    // anything between the listbox and an option must be role=presentation/none
    for (const li of Array.from(list.children)) expect(['presentation', 'none']).toContain(li.getAttribute('role'))
  })
})
