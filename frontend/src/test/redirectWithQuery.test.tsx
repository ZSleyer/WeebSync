import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import RedirectWithQuery from '../components/RedirectWithQuery'

const Where = () => {
  const l = useLocation()
  return <p>{l.pathname + l.search + l.hash}</p>
}

const mount = (from: string, to: string, rewrite?: (p: URLSearchParams) => URLSearchParams) =>
  render(
    <MemoryRouter initialEntries={[from]}>
      <Routes>
        <Route path="/old" element={<RedirectWithQuery to={to} rewrite={rewrite} />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )

describe('RedirectWithQuery', () => {
  it('keeps the query string', () => {
    mount('/old?server=2&path=a%2Fb', '/files')
    expect(screen.getByText('/files?server=2&path=a%2Fb')).toBeInTheDocument()
  })

  it('rewrites parameters and keeps a hash on the target', () => {
    mount('/old?path=x', '/files#top', (p) => {
      p.set('source', 'local')
      return p
    })
    expect(screen.getByText('/files?path=x&source=local#top')).toBeInTheDocument()
  })

  it('emits no stray question mark without a query', () => {
    mount('/old', '/settings/general#about')
    expect(screen.getByText('/settings/general#about')).toBeInTheDocument()
  })
})
