import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { BackLink } from '../components/BackLink'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

const Where = () => <p>at {useLocation().pathname}</p>

describe('BackLink', () => {
  it('leads to the parent when nothing of the app is behind the screen', () => {
    render(
      <MemoryRouter initialEntries={['/files/trash']}>
        <Routes>
          <Route path="/files/trash" element={<BackLink to="/files" />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: 'nav.back' })
    expect(link).toHaveAttribute('href', '/files')
    fireEvent.click(link)
    expect(screen.getByText('at /files')).toBeInTheDocument()
  })
})
