import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Look from '../pages/settings/Look'

const setLocalePref = vi.fn()
const readLocalePref = vi.fn(() => 'system')
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'de' } }),
}))
vi.mock('../locales', () => ({
  LOCALES: [
    { code: 'de', label: 'Deutsch' },
    { code: 'en', label: 'English' },
  ],
  readLocalePref: () => readLocalePref(),
  setLocalePref: (p: string) => setLocalePref(p),
}))

describe('Look', () => {
  afterEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.theme
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
    expect(setLocalePref).toHaveBeenCalledWith('en')
  })

  it('offers System first and marks the stored choice', () => {
    readLocalePref.mockReturnValueOnce('de')
    render(<Look />)
    const group = screen.getByRole('group', { name: 'settings.language' })
    const names = [...group.querySelectorAll('button')].map((b) => b.textContent)
    expect(names).toEqual(['settings.language_system', 'Deutsch', 'English'])
    expect(screen.getByRole('button', { name: 'Deutsch' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'settings.language_system' }))
    expect(setLocalePref).toHaveBeenCalledWith('system')
    expect(screen.getByRole('button', { name: 'settings.language_system' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('turns motion off through the document flag', () => {
    render(<Look />)
    fireEvent.click(screen.getByRole('switch', { name: 'settings.motion' }))
    expect(document.documentElement.dataset.motion).toBe('off')
    expect(localStorage.getItem('weebsync.motion')).toBe('off')
  })

  it('offers no switch for landing on the episode from Heute', () => {
    render(<Look />)
    // motion is the one switch left on the page
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(1)
    expect(switches[0]).toHaveAccessibleName(/settings.motion/)
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
    fireEvent.click(screen.getByRole('switch', { name: /settings.motion/ }))
    expect(document.documentElement.dataset.motion).toBe('off')
    vi.restoreAllMocks()
  })
})
