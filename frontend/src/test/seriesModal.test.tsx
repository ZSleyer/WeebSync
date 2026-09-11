import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter, Route, Routes, Link } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SeriesModalProvider, useSeriesModal } from '../components/SeriesModal'
import type { Media } from '../api'

const media = { id: 7, title: { romaji: 'Frieren' }, coverImage: {}, episodes: 28, seasonYear: 2023, format: 'TV', averageScore: 0, genres: [] } as unknown as Media

function Opener() {
  const { open } = useSeriesModal()
  return (
    <>
      <button onClick={() => open({ id: 7, media, extra: <p>Versionen: 2</p> })}>Details zu Frieren</button>
      <Link to="/elsewhere">weg</Link>
    </>
  )
}

function app() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <SeriesModalProvider>
          <Routes>
            <Route path="/" element={<Opener />} />
            <Route path="/elsewhere" element={<p>anderswo</p>} />
          </Routes>
        </SeriesModalProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SeriesModalProvider', () => {
  it('opens the one title card with the record and the caller rows', () => {
    app()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByText('Details zu Frieren'))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Frieren')
    expect(dialog).toHaveTextContent('Versionen: 2')
  })

  it('closes when the route changes', () => {
    app()
    fireEvent.click(screen.getByText('Details zu Frieren'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByText('weg'))
    expect(screen.getByText('anderswo')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
