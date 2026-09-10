import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Look from '../pages/settings/Look'

const changeLanguage = vi.fn()
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'de', changeLanguage } }),
}))
vi.mock('../locales', () => ({
  LOCALES: [
    { code: 'de', label: 'Deutsch' },
    { code: 'en', label: 'English' },
  ],
}))

describe('Look', () => {
  afterEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.accent
    delete document.documentElement.dataset.motion
  })

  it('offers the accents as one radio group that follows the document', () => {
    document.documentElement.dataset.accent = 'cyan'
    render(<Look />)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(8)
    expect(screen.getByRole('radio', { name: /cyan/ })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: /crimson/ }))
    expect(document.documentElement.dataset.accent).toBe('crimson')
    expect(localStorage.getItem('weebsync.accent')).toBe('crimson')
    expect(screen.getByRole('radio', { name: /crimson/ })).toBeChecked()
  })

  it('stores the theme choice and switches the language', () => {
    render(<Look />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.theme_light' }))
    expect(localStorage.getItem('weebsync.theme')).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(changeLanguage).toHaveBeenCalledWith('en')
  })

  it('turns motion off through the document flag', () => {
    render(<Look />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'settings.motion' }))
    expect(document.documentElement.dataset.motion).toBe('off')
    expect(localStorage.getItem('weebsync.motion')).toBe('off')
  })
})
