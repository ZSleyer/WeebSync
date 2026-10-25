import { describe, expect, it } from 'vitest'
import { assToVtt } from '../pages/assVtt'

const script = (events: string, format = 'Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text') =>
  [
    '[Script Info]',
    'ScriptType: v4.00+',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize',
    'Style: Default,Arial,48',
    '',
    '[Events]',
    `Format: ${format}`,
    events,
    '',
  ].join('\r\n')

// the cues of a WebVTT file as [start, end, text]
const cues = (vtt: string) =>
  vtt
    .split('\n\n')
    .slice(1)
    .filter(Boolean)
    .map((block) => {
      const [time, ...text] = block.split('\n')
      const [start, end] = time.split(' --> ')
      return [start, end, text.join('\n')]
    })

describe('assToVtt', () => {
  it('writes a WebVTT file with the times in milliseconds', () => {
    const vtt = assToVtt(script('Dialogue: 0,0:00:01.50,1:02:03.04,Default,,0,0,0,,Hello'))
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(cues(vtt)).toEqual([['00:00:01.500', '01:02:03.040', 'Hello']])
  })

  it('drops the override tags and keeps the text around them', () => {
    const vtt = assToVtt(
      script('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an8\\pos(320,50)}Top {\\i1}line{\\i0} here'),
    )
    expect(cues(vtt)).toEqual([['00:00:01.000', '00:00:02.000', 'Top line here']])
  })

  it('breaks the line at \\N and keeps \\h as a hard space', () => {
    const vtt = assToVtt(script('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,One\\Ntwo\\nsoft\\h!'))
    expect(cues(vtt)).toEqual([['00:00:01.000', '00:00:02.000', 'One\ntwo soft !']])
  })

  it('keeps the commas of the text', () => {
    const vtt = assToVtt(script('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Well, well, well.'))
    expect(cues(vtt)[0][2]).toBe('Well, well, well.')
  })

  it('reads the columns from the Format line', () => {
    const vtt = assToVtt(script('Dialogue: Default,0:00:05.00,0:00:04.00,Moved', 'Style, End, Start, Text'))
    expect(cues(vtt)).toEqual([['00:00:04.000', '00:00:05.000', 'Moved']])
  })

  it('keeps overlapping events as cues of their own, sorted by start', () => {
    const vtt = assToVtt(
      script(
        [
          'Dialogue: 0,0:00:03.00,0:00:06.00,Default,,0,0,0,,Second',
          'Dialogue: 0,0:00:01.00,0:00:05.00,Default,,0,0,0,,First',
        ].join('\r\n'),
      ),
    )
    expect(cues(vtt)).toEqual([
      ['00:00:01.000', '00:00:05.000', 'First'],
      ['00:00:03.000', '00:00:06.000', 'Second'],
    ])
  })

  it('writes a line a typeset repeats on several layers once', () => {
    const vtt = assToVtt(
      script(
        [
          'Dialogue: 0,0:00:01.00,0:00:02.00,Sign,,0,0,0,,{\\bord8}Station',
          'Dialogue: 1,0:00:01.00,0:00:02.00,Sign,,0,0,0,,{\\bord0}Station',
        ].join('\r\n'),
      ),
    )
    expect(cues(vtt)).toEqual([['00:00:01.000', '00:00:02.000', 'Station']])
  })

  it('leaves out comments, drawings, empty and backwards events', () => {
    const vtt = assToVtt(
      script(
        [
          'Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,a note',
          'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}',
          'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\fad(200,200)}',
          'Dialogue: 0,0:00:03.00,0:00:02.00,Default,,0,0,0,,backwards',
          'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,{\\p1}m 0 0 l 1 1{\\p0}kept',
        ].join('\r\n'),
      ),
    )
    expect(cues(vtt)).toEqual([['00:00:04.000', '00:00:05.000', 'kept']])
  })

  it('escapes what WebVTT reads as markup', () => {
    const vtt = assToVtt(script('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,a < b & c --> d'))
    expect(cues(vtt)[0][2]).toBe('a &lt; b &amp; c --&gt; d')
  })

  it('ignores lines outside the Events section', () => {
    const vtt = assToVtt('[Script Info]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,nope\n')
    expect(cues(vtt)).toEqual([])
  })
})
