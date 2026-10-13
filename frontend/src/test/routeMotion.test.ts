import { describe, expect, it } from 'vitest'
import { routeMotion, topPage } from '../components/RouteTransition'

const phone = (from: string, to: string, back: { from?: string; to?: string } = {}) =>
  routeMotion({ path: from, back: back.from }, { path: to, back: back.to }, false)

describe('routeMotion', () => {
  it('fades between top-level pages, no slide', () => {
    expect(phone('/', '/calendar')).toEqual({ page: 'anim-route-page', section: '' })
    expect(phone('/files', '/')).toEqual({ page: 'anim-route-page', section: '' })
  })

  it('pushes into a stacked screen and pops back out', () => {
    expect(phone('/settings', '/settings/account', { to: '/settings' })).toEqual({
      page: '',
      section: 'anim-route-push',
    })
    expect(phone('/settings/account', '/settings', { from: '/settings' })).toEqual({
      page: '',
      section: 'anim-route-pop',
    })
    // a stacked screen on another page slides <main> itself
    expect(phone('/files', '/rename', { to: '/files' }).page).toBe('anim-route-push')
    expect(phone('/rename', '/files', { from: '/files' }).page).toBe('anim-route-pop')
    expect(phone('/settings/account', '/calendar', { from: '/settings' }).page).toBe('anim-route-page')
  })

  it('only fades the content between sibling tabs', () => {
    expect(phone('/discover/merkliste', '/discover/trending')).toEqual({ page: '', section: 'anim-route-swap' })
    // the assistant and the ignored items are tabs too, not stacked screens
    expect(phone('/discover/merkliste', '/discover/assistent').section).toBe('anim-route-swap')
    // the rules page stacks on settings on a phone
    expect(phone('/settings', '/rules', { to: '/settings' }).page).toBe('anim-route-push')
  })

  it('treats desktop sections as siblings', () => {
    const m = routeMotion({ path: '/settings/general', back: '/settings' }, { path: '/discover/assistent' }, true)
    // a sidebar tap from a stacked section is a change of page, not a pop
    expect(m.page).toBe('anim-route-page')
    expect(routeMotion({ path: '/discover/merkliste' }, { path: '/discover/assistent' }, true)).toEqual({
      page: '',
      section: 'anim-route-swap',
    })
  })

  it('does not move again when an index forwards to its first section', () => {
    expect(routeMotion({ path: '/discover' }, { path: '/discover/merkliste' }, false, true)).toEqual({
      page: '',
      section: '',
    })
  })

  it('keys <main> on the top-level page', () => {
    expect(topPage('/settings/account')).toBe('/settings')
    expect(topPage('/')).toBe('/')
  })
})
