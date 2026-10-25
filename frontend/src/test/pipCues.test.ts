import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachPipCues } from '../pages/pipCues'

// jsdom has no TextTrack: each <track> gets a stand-in with a mode
const tracks = new WeakMap<object, { mode: TextTrackMode }>()
let pipElement: Element | null = null

beforeEach(() => {
  Object.defineProperty(HTMLTrackElement.prototype, 'track', {
    get() {
      if (!tracks.has(this)) tracks.set(this, { mode: 'disabled' })
      return tracks.get(this)
    },
    configurable: true,
  })
  Object.defineProperty(document, 'pictureInPictureElement', { get: () => pipElement, configurable: true })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:cues'), revokeObjectURL: vi.fn() }))
  pipElement = null
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n\n'
const enter = (v: HTMLVideoElement) => {
  pipElement = v
  v.dispatchEvent(new Event('enterpictureinpicture'))
}
const leave = (v: HTMLVideoElement) => {
  pipElement = null
  v.dispatchEvent(new Event('leavepictureinpicture'))
}

describe('attachPipCues', () => {
  it('loads the cues hidden, so they never stand over the page next to libass', () => {
    const v = document.createElement('video')
    attachPipCues(v, VTT)
    const el = v.querySelector('track')!
    expect(el.kind).toBe('subtitles')
    expect(el.src).toBe('blob:cues')
    expect(el.track.mode).toBe('hidden')
  })

  it('shows them while the video floats in the browser window and hides them after', () => {
    const v = document.createElement('video')
    attachPipCues(v, VTT)
    const el = v.querySelector('track')!
    enter(v)
    expect(el.track.mode).toBe('showing')
    leave(v)
    expect(el.track.mode).toBe('hidden')
  })

  it('shows them at once for a track picked while the video already floats', () => {
    const v = document.createElement('video')
    pipElement = v
    attachPipCues(v, VTT)
    expect(v.querySelector('track')!.track.mode).toBe('showing')
  })

  it('takes the track away and lets go of its cues', () => {
    const v = document.createElement('video')
    const undo = attachPipCues(v, VTT)
    const el = v.querySelector('track')!
    undo()
    expect(v.querySelector('track')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:cues')
    enter(v)
    expect(el.track.mode).not.toBe('showing')
  })
})
