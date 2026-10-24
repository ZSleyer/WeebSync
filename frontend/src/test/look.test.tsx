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
    delete document.documentElement.dataset.scheme
    delete document.documentElement.dataset.motion
  })

  it('offers the two schemes and paints the document in the picked one', () => {
    render(<Look />)
    const group = screen.getByRole('radiogroup', { name: 'settings.scheme' })
    expect(group).toBeInTheDocument()
    const lycoris = screen.getByRole('radio', { name: /settings.schemes.lycoris/ })
    const recoil = screen.getByRole('radio', { name: /settings.schemes.recoil/ })
    expect(lycoris).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(recoil)
    expect(document.documentElement.dataset.scheme).toBe('recoil')
    expect(localStorage.getItem('weebsync.scheme')).toBe('recoil')
    expect(recoil).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(lycoris)
    expect(document.documentElement.dataset.scheme).toBeUndefined()
    expect(localStorage.getItem('weebsync.scheme')).toBe('lycoris')
  })

  it('moves the scheme with the arrow keys', () => {
    render(<Look />)
    fireEvent.keyDown(screen.getByRole('radio', { name: /settings.schemes.lycoris/ }), { key: 'ArrowRight' })
    expect(document.documentElement.dataset.scheme).toBe('recoil')
    expect(screen.getByRole('radio', { name: /settings.schemes.recoil/ })).toHaveFocus()
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
    fireEvent.click(screen.getByRole('switch', { name: 'settings.motion' }))
    expect(document.documentElement.dataset.motion).toBe('off')
    expect(localStorage.getItem('weebsync.motion')).toBe('off')
  })

  it('still applies theme, scheme and motion when storage refuses writes', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    render(<Look />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.theme_light' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    fireEvent.click(screen.getByRole('radio', { name: /settings.schemes.recoil/ }))
    expect(document.documentElement.dataset.scheme).toBe('recoil')
    vi.restoreAllMocks()
  })
})
