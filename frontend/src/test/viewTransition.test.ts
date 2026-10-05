import { afterEach, describe, expect, it, vi } from 'vitest'
import { localTransition, morphTransition } from '@weebsync/design-system'

// loose on purpose: the stand-in only has what the helpers read
const doc = document as unknown as { startViewTransition?: unknown }

// jsdom has no view transitions; a stand-in that runs the update at once
const fake = () => {
  doc.startViewTransition = vi.fn((cb: () => void) => {
    cb()
    return { finished: Promise.resolve(), ready: Promise.resolve() }
  })
}

describe('view transitions', () => {
  afterEach(() => {
    delete doc.startViewTransition
  })

  it('just updates where the browser has none', async () => {
    const update = vi.fn()
    await localTransition(null, update)
    expect(update).toHaveBeenCalledTimes(1)
  })

  // the names live only as long as the transition: a name that stays would cut
  // the element out of every later transition, the route's included
  it('names the scope and frees <main> for a local one, then cleans up', async () => {
    fake()
    const scope = document.createElement('div')
    let during: [boolean, boolean] = [false, false]
    await localTransition(scope, () => {
      during = [document.documentElement.hasAttribute('data-vt-local'), scope.hasAttribute('data-vt')]
    })
    expect(during).toEqual([true, true])
    expect(document.documentElement.hasAttribute('data-vt-local')).toBe(false)
    expect(scope.hasAttribute('data-vt')).toBe(false)
  })

  // the source carries the name into the old state only; in the new one the
  // counterpart has it, so two elements never share it
  it('hands the morph name from the source to its counterpart', async () => {
    fake()
    const from = document.createElement('img')
    let named = 'x'
    let morphing = false
    await morphTransition(from, () => {
      named = from.style.viewTransitionName
      morphing = document.documentElement.hasAttribute('data-vt-morph')
    })
    expect(named).toBe('')
    expect(morphing).toBe(true)
    expect(document.documentElement.hasAttribute('data-vt-morph')).toBe(false)
  })

  it('stays still with motion turned off', async () => {
    fake()
    document.documentElement.dataset.motion = 'off'
    const update = vi.fn()
    await morphTransition(document.createElement('img'), update)
    expect(doc.startViewTransition).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledTimes(1)
    delete document.documentElement.dataset.motion
  })
})
