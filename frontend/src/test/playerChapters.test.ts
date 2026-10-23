import { describe, expect, it } from 'vitest'
import { chapterAt, chaptersVtt } from '../pages/playerChapters'

const chapters = [
  { start: 0, end: 90.5, title: 'Prologue' },
  { start: 90.5, end: 180, title: 'Opening', kind: 'op' as const },
  { start: 180, end: 3725.25 },
]

describe('playerChapters', () => {
  it('writes the chapters as WebVTT cues', () => {
    expect(chaptersVtt(chapters, (n) => `Chapter ${n}`)).toBe(
      'WEBVTT\n\n' +
        '00:00:00.000 --> 00:01:30.500\nPrologue\n\n' +
        '00:01:30.500 --> 00:03:00.000\nOpening\n\n' +
        '00:03:00.000 --> 01:02:05.250\nChapter 3\n',
    )
  })

  it('keeps a title to one plain line', () => {
    const vtt = chaptersVtt([{ start: 0, end: 1, title: 'A <b>&</b>\n--> B' }], String)
    expect(vtt).toContain('\nA &lt;b&gt;&amp;&lt;/b&gt; → B\n')
  })

  it('finds the chapter playing at a time', () => {
    expect(chapterAt(chapters, 0)?.title).toBe('Prologue')
    expect(chapterAt(chapters, 90.5)?.kind).toBe('op')
    expect(chapterAt(chapters, 179.9)?.kind).toBe('op')
    expect(chapterAt(chapters, 180)?.title).toBeUndefined()
    expect(chapterAt(chapters, 4000)).toBeUndefined()
  })
})
