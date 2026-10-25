import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import About from '../pages/settings/About'

vi.mock('../hooks', () => ({
  useAuth: () => ({ data: null }),
  useVersion: () => ({ data: undefined }),
  updateText: () => '',
}))

const renderAbout = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <About />
    </QueryClientProvider>,
  )

describe('About credits', () => {
  it('credits DB-IP with its mark, named by the link text its licence prescribes', () => {
    renderAbout()
    const credits = screen.getByRole('list', { name: 'about.creditsTitle' })
    const link = within(credits).getByRole('link', { name: 'IP Geolocation by DB-IP' })
    expect(link).toHaveAttribute('href', 'https://db-ip.com')
    const mark = within(link).getByRole('img', { name: 'IP Geolocation by DB-IP' })
    expect(mark).toHaveAttribute('data-provider', 'DB-IP')
    // the committed SVG itself (inlined by the test transform, a file in the build)
    expect(mark.getAttribute('src')).toMatch(/svg/)
  })

  it('shows a mark for every provider, like the others', () => {
    renderAbout()
    const credits = screen.getByRole('list', { name: 'about.creditsTitle' })
    const marks = [...credits.querySelectorAll('img.ws-d-pmark')].map((i) => i.getAttribute('data-provider'))
    expect(marks).toEqual(['TMDB', 'TVDB', 'AniList', 'DB-IP'])
  })
})
