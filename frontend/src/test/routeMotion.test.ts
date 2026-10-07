import { describe, expect, it } from 'vitest'
import { routeMotion, topPage } from '../components/RouteTransition'

const phone = (from: string, to: string, back: { from?: string; to?: string } = {}) =>
  routeMotion({ path: from, back: back.from }, { path: to, back: back.to }, false)

describe('routeMotion', () => {
  it('fades between top-level pages, no slide', () => {
    expect(phone('/', '/calendar')).toEqual({ page: 'anim-t-reveal', section: '' })
    expect(phone('/files', '/')).toEqual({ page: 'anim-t-reveal', section: '' })
  })

  it('pushes into a stacked screen and pops back out', () => {
    expect(phone('/settings', '/settings/account', { to: '/settings' })).toEqual({
      page: '',
      section: 'anim-slide-from-right',
    })
    expect(phone('/settings/account', '/settings', { from: '/settings' })).toEqual({
      page: '',
      section: 'anim-slide-from-left',
    })
    // a stacked screen on another page slides <main> itself
    expect(phone('/files', '/rename', { to: '/files' }).page).toBe('anim-slide-from-right')
    expect(phone('/rename', '/files', { from: '/files' }).page).toBe('anim-slide-from-left')
    expect(phone('/settings/account', '/calendar', { from: '/settings' }).page).toBe('anim-t-reveal')
  })

  it('only fades the content between sibling tabs', () => {
    expect(phone('/suggestions/watchlist', '/suggestions/trending')).toEqual({ page: '', section: 'anim-fade-in' })
  })

  it('treats desktop sections as siblings', () => {
    const m = routeMotion({ path: '/settings/general', back: '/settings' }, { path: '/suggestions/assistant' }, true)
    // a sidebar tap from a stacked section is a change of page, not a pop
    expect(m.page).toBe('anim-t-reveal')
    expect(
      routeMotion({ path: '/suggestions/watchlist' }, { path: '/suggestions/assistant', back: '/suggestions' }, true),
    ).toEqual({
      page: '',
      section: 'anim-fade-in',
    })
  })

  it('does not move again when an index forwards to its first section', () => {
    expect(routeMotion({ path: '/suggestions' }, { path: '/suggestions/watchlist' }, false, true)).toEqual({
      page: '',
      section: '',
    })
  })

  it('keys <main> on the top-level page', () => {
    expect(topPage('/settings/account')).toBe('/settings')
    expect(topPage('/')).toBe('/')
  })
})
