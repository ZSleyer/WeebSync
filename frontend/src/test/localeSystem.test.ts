import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The language setting's "System" option: the browser's language list is
// walked in order and the first locale with a translation wins, matched by
// primary subtag. Each case loads the locale module fresh, the way a page
// load does, with navigator.languages set beforehand.

let languages: string[] = []

async function load() {
  vi.resetModules()
  return (await import('../locales')).default
}

describe('system language', () => {
  beforeEach(() => {
    vi.spyOn(navigator, 'languages', 'get').mockImplementation(() => languages)
    vi.spyOn(navigator, 'language', 'get').mockImplementation(() => languages[0] ?? '')
    // the backend sync is fire-and-forget; keep it off the network
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}'))),
    )
  })
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('takes German from de-DE', async () => {
    languages = ['de-DE']
    const i18n = await load()
    expect(i18n.language).toBe('de')
    expect(document.documentElement.lang).toBe('de')
  })

  it('counts de-AT as German', async () => {
    languages = ['de-AT', 'en-US']
    expect((await load()).language).toBe('de')
  })

  it('skips a language without a translation and takes the next one', async () => {
    languages = ['fr-FR', 'de']
    expect((await load()).language).toBe('de')
  })

  it('falls back to English when nothing matches', async () => {
    languages = ['ja']
    expect((await load()).language).toBe('en')
  })

  it('keeps an explicit choice over the system language', async () => {
    localStorage.setItem('weebsync.locale', 'en')
    languages = ['de-DE']
    expect((await load()).language).toBe('en')
  })

  it('follows a languagechange only while the setting is System', async () => {
    languages = ['ja']
    const i18n = await load()
    expect(i18n.language).toBe('en')
    languages = ['de-CH']
    window.dispatchEvent(new Event('languagechange'))
    await vi.waitFor(() => expect(i18n.language).toBe('de'))

    const { setLocalePref } = await import('../locales')
    await setLocalePref('en')
    expect(localStorage.getItem('weebsync.locale')).toBe('en')
    languages = ['de-DE']
    window.dispatchEvent(new Event('languagechange'))
    await Promise.resolve()
    expect(i18n.language).toBe('en')
  })

  it('choosing System forgets the stored language and resolves it again', async () => {
    localStorage.setItem('weebsync.locale', 'en')
    languages = ['de-DE']
    const i18n = await load()
    const { setLocalePref, readLocalePref } = await import('../locales')
    await setLocalePref('system')
    expect(localStorage.getItem('weebsync.locale')).toBeNull()
    expect(readLocalePref()).toBe('system')
    expect(i18n.language).toBe('de')
  })

  it('does not store a language that only followed the system', async () => {
    languages = ['de-DE']
    const i18n = await load()
    await i18n.changeLanguage('de')
    expect(localStorage.getItem('weebsync.locale')).toBeNull()
  })

  it('lists every locale file under its own name', async () => {
    await load()
    const { LOCALES } = await import('../locales')
    expect(LOCALES).toEqual([
      { code: 'de', label: 'Deutsch' },
      { code: 'en', label: 'English' },
    ])
  })
})
