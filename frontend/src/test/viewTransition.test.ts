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

  // the poster shares the dialog's name on the side the dialog is not: before
  // the update on the way in, after it on the way back - never both at once
  it('names the poster on the side the dialog is not, both ways', async () => {
    fake()
    const from = document.body.appendChild(document.createElement('img'))
    const seen = async (back: boolean) => {
      const at: string[] = []
      doc.startViewTransition = vi.fn((cb: () => void) => {
        at.push(from.style.viewTransitionName)
        cb()
        at.push(from.style.viewTransitionName)
        return { finished: Promise.resolve(), ready: Promise.resolve() }
      })
      await morphTransition(from, () => {}, back)
      return at
    }
    expect(await seen(false)).toEqual(['morph-dialog', ''])
    expect(await seen(true)).toEqual(['', 'morph-dialog'])
    expect(from.style.viewTransitionName).toBe('')
    expect(document.documentElement.hasAttribute('data-vt-morph')).toBe(false)
    expect(document.documentElement.hasAttribute('data-vt-back')).toBe(false)
    from.remove()
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
