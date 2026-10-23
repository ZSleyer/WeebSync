import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useChapterSkip } from '../pages/playerChapters'
import type { PlayChapter } from '../pages/PlayerInfo'

// jsdom plays nothing: currentTime is a plain attribute, duration is NaN and
// no event fires by itself, so the tests set the time and dispatch the events.
const chaptersOf = (): PlayChapter[] => [
  { start: 0, end: 90, title: 'Prologue' },
  { start: 90, end: 180, title: 'Opening', kind: 'op' },
  { start: 180, end: 1300, title: 'Episode' },
  { start: 1300, end: 1420, title: 'Ending', kind: 'ed' },
]

function setup(chapters: PlayChapter[] = chaptersOf(), duration?: number) {
  const video = document.createElement('video')
  if (duration !== undefined) Object.defineProperty(video, 'duration', { value: duration })
  const ref = { current: video }
  const hook = renderHook(({ list }) => useChapterSkip(ref, list), { initialProps: { list: chapters } })
  const emit = (type: string, time: number) =>
    act(() => {
      video.currentTime = time
      video.dispatchEvent(new Event(type))
    })
  return { video, hook, emit }
}

describe('useChapterSkip', () => {
  it('has nothing without chapters', () => {
    const { hook, emit } = setup([])
    emit('timeupdate', 100)
    expect(hook.result.current.chapter).toBeUndefined()
    expect(hook.result.current.skippable).toBeUndefined()
  })

  it('offers the opening while inside it', () => {
    const { hook, emit } = setup()
    expect(hook.result.current.skippable).toBeUndefined()
    emit('timeupdate', 100)
    expect(hook.result.current.chapter?.title).toBe('Opening')
    expect(hook.result.current.skippable?.kind).toBe('op')
  })

  it('skips to the end of the opening and drops the card in the next chapter', () => {
    const { video, hook, emit } = setup()
    emit('timeupdate', 100)
    act(() => hook.result.current.skip())
    expect(video.currentTime).toBe(180)
    expect(hook.result.current.skippable).toBeUndefined()
    emit('timeupdate', 181)
    expect(hook.result.current.chapter?.title).toBe('Episode')
    expect(hook.result.current.skippable).toBeUndefined()
  })

  it('clamps a skip to the duration near the end of the file', () => {
    const { video, hook, emit } = setup(chaptersOf(), 1350)
    emit('timeupdate', 1310)
    expect(hook.result.current.skippable?.kind).toBe('ed')
    act(() => hook.result.current.skip())
    expect(video.currentTime).toBe(1350)
  })

  it('keeps a dismissed card hidden until the chapter is left and entered again', () => {
    const { hook, emit } = setup()
    emit('timeupdate', 100)
    act(() => hook.result.current.dismiss())
    expect(hook.result.current.skippable).toBeUndefined()
    emit('timeupdate', 120)
    expect(hook.result.current.chapter?.title).toBe('Opening')
    expect(hook.result.current.skippable).toBeUndefined()
    emit('timeupdate', 200)
    emit('seeking', 95)
    expect(hook.result.current.skippable?.kind).toBe('op')
  })

  it('follows a seek at once, before any timeupdate', () => {
    const { hook, emit } = setup()
    emit('seeking', 1400)
    expect(hook.result.current.chapter?.title).toBe('Ending')
    expect(hook.result.current.skippable?.kind).toBe('ed')
    emit('seeked', 10)
    expect(hook.result.current.chapter?.title).toBe('Prologue')
  })

  it('never offers a plain chapter', () => {
    const { hook, emit } = setup()
    for (const t of [0, 50, 200, 1000]) {
      emit('timeupdate', t)
      expect(hook.result.current.chapter).toBeDefined()
      expect(hook.result.current.skippable).toBeUndefined()
    }
  })

  it('does nothing on skip without a skippable chapter', () => {
    const { video, hook, emit } = setup()
    emit('timeupdate', 10)
    act(() => hook.result.current.skip())
    expect(video.currentTime).toBe(10)
  })

  it('resyncs when the chapters change', () => {
    const { hook, emit } = setup()
    emit('timeupdate', 100)
    expect(hook.result.current.chapter?.title).toBe('Opening')
    const next: PlayChapter[] = [
      { start: 0, end: 50, title: 'A' },
      { start: 50, end: 150, title: 'B', kind: 'ed' },
    ]
    hook.rerender({ list: next })
    expect(hook.result.current.chapter?.title).toBe('B')
    expect(hook.result.current.skippable?.kind).toBe('ed')
    // the old listener is gone, the new list is the one followed
    emit('timeupdate', 10)
    expect(hook.result.current.chapter?.title).toBe('A')
  })

  it('clears the chapter when the list becomes empty', () => {
    const { hook, emit } = setup()
    emit('timeupdate', 100)
    hook.rerender({ list: [] })
    expect(hook.result.current.chapter).toBeUndefined()
    expect(hook.result.current.skippable).toBeUndefined()
  })
})
