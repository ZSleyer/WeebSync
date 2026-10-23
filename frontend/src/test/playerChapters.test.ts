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

  it('writes stamps over an hour and rounds the milliseconds', () => {
    const vtt = chaptersVtt(
      [
        { start: 3599.9996, end: 7325.0004, title: 'A' },
        { start: 360000, end: 360000.5, title: 'B' },
      ],
      String,
    )
    expect(vtt).toContain('01:00:00.000 --> 02:02:05.000\nA')
    expect(vtt).toContain('100:00:00.000 --> 100:00:00.500\nB')
  })

  it('writes only valid cue lines and plain text bodies', () => {
    const vtt = chaptersVtt(
      [
        { start: 0.0004, end: 59.9996, title: 'x\r\ny\rz\n<i>&</i> --> w' },
        { start: 59.9996, end: 4000.1, title: '' },
      ],
      (n) => `Chapter ${n}`,
    )
    const cue = /^\d{2,}:\d{2}:\d{2}\.\d{3} --> \d{2,}:\d{2}:\d{2}\.\d{3}$/
    const blocks = vtt.trimEnd().split('\n\n').slice(1)
    expect(blocks).toHaveLength(2)
    for (const block of blocks) {
      const lines = block.split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(cue)
      expect(lines[1]).not.toMatch(/[\r<>]|-->|&(?!amp;|lt;|gt;)/)
    }
    expect(vtt).toContain('00:00:00.000 --> 00:01:00.000\n')
    expect(vtt).toContain('x y z &lt;i&gt;&amp;&lt;/i&gt; → w')
    expect(vtt).toContain('Chapter 2')
  })

  it('starts an empty list with the WEBVTT header', () => {
    expect(chaptersVtt([], String).startsWith('WEBVTT\n')).toBe(true)
  })

  it('finds the chapter playing at a time', () => {
    expect(chapterAt(chapters, 0)?.title).toBe('Prologue')
    expect(chapterAt(chapters, 90.5)?.kind).toBe('op')
    expect(chapterAt(chapters, 179.9)?.kind).toBe('op')
    expect(chapterAt(chapters, 180)?.title).toBeUndefined()
    expect(chapterAt(chapters, 4000)).toBeUndefined()
  })
})
