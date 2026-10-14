import { describe, expect, it } from 'vitest'
import { parseInline, parseThreadText, relTime, shortThreadTitle } from '../components/threadText'

describe('relTime', () => {
  it('picks the largest fitting unit', () => {
    const now = 1_000_000_000_000
    expect(relTime(now / 1000 - 3 * 86400, now, 'en')).toBe('3 days ago')
    expect(relTime(now / 1000 - 30, now, 'de')).toBe('vor 30 Sekunden')
    // a reply sent after the sheet opened is not in the future
    expect(relTime(now / 1000 + 25, now, 'en')).toBe('now')
  })
})

const SLIME = [
  'Tensei Shitara Slime Datta Ken 3rd Season',
  'That Time I Got Reincarnated as a Slime Season 3',
  '転生したらスライムだった件 第3期',
  'TenSura',
]

describe('shortThreadTitle', () => {
  it('drops the series name and the spoiler tag and lifts the episode', () => {
    expect(
      shortThreadTitle('[Spoilers] That Time I Got Reincarnated as a Slime Season 3 - Episode 21 Discussion', SLIME),
    ).toEqual({ spoiler: true, episode: 21, rest: '' })
    expect(shortThreadTitle('That Time I Got Reincarnated as a Slime Season 3 - Episode 24 Discussion', SLIME)).toEqual(
      {
        spoiler: false,
        episode: 24,
        rest: '',
      },
    )
  })

  it('matches names in any case and keeps what is not the series', () => {
    expect(shortThreadTitle('tensura OST thoughts?', SLIME)).toEqual({ spoiler: false, rest: 'OST thoughts?' })
  })

  it('keeps an episode range as text and drops the trailing discussion', () => {
    expect(
      shortThreadTitle('[Spoilers] Sousou No Frieren - Premiere/Episodes 1-4 Discussion', ['Sousou no Frieren']),
    ).toEqual({
      spoiler: true,
      rest: 'Premiere/Episodes 1-4',
    })
    expect(shortThreadTitle('Frieren Episode 2-3 Discussion ', ['Frieren'])).toEqual({
      spoiler: false,
      rest: 'Episode 2-3',
    })
  })

  it('keeps what is left after a shorter name', () => {
    expect(
      shortThreadTitle('[Spoilers] That Time I Got Reincarnated as a Slime Season 2 - Episode 3', [
        'That Time I Got Reincarnated as a Slime',
      ]),
    ).toEqual({ spoiler: true, episode: 3, rest: 'Season 2' })
  })

  it('leaves the title alone when no name matches, and ignores tiny names', () => {
    expect(shortThreadTitle('Best girl?', ['OP', '', null, undefined])).toEqual({ spoiler: false, rest: 'Best girl?' })
  })
})

describe('parseThreadText', () => {
  it('splits paragraphs at blank lines and keeps single line breaks', () => {
    expect(parseThreadText('one\ntwo\n\n\nthree')).toEqual([
      [{ kind: 'text', text: 'one' }, { kind: 'br' }, { kind: 'text', text: 'two' }],
      [{ kind: 'text', text: 'three' }],
    ])
  })

  it('makes spoilers their own piece, across lines', () => {
    expect(parseThreadText('before ~!he dies\n\nat the end!~ after')).toEqual([
      [
        { kind: 'text', text: 'before ' },
        {
          kind: 'spoiler',
          children: [
            { kind: 'text', text: 'he dies' },
            { kind: 'br' },
            { kind: 'br' },
            { kind: 'text', text: 'at the end' },
          ],
        },
        { kind: 'text', text: ' after' },
      ],
    ])
  })

  it('turns images and videos into plain links and keeps urls', () => {
    expect(
      parseInline(
        'img520(https://example.com/a.jpg) youtube(dQw4w9WgXcQ) webm(https://x.test/v.webm) see https://example.com/anime/1.',
      ),
    ).toEqual([
      { kind: 'media', media: 'image', href: 'https://example.com/a.jpg' },
      { kind: 'text', text: ' ' },
      { kind: 'media', media: 'video', href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      { kind: 'text', text: ' ' },
      { kind: 'media', media: 'video', href: 'https://x.test/v.webm' },
      { kind: 'text', text: ' see ' },
      { kind: 'link', href: 'https://example.com/anime/1', text: 'https://example.com/anime/1' },
      { kind: 'text', text: '.' },
    ])
  })

  it('reads markdown links and strips formatting markers', () => {
    expect(parseInline('~~~__Big__ *news* [here](https://a.test/x)~~~')).toEqual([
      { kind: 'text', text: 'Big news ' },
      { kind: 'link', href: 'https://a.test/x', text: 'here' },
    ])
  })

  it('never hands out a script link or markup', () => {
    const out = parseThreadText(
      '<script>alert(1)</script><img src=x onerror=alert(1)> [x](javascript:alert(1)) img(javascript:alert(1)) youtube(javascript:alert(1))',
    )
    const flat = JSON.stringify(out)
    expect(flat).not.toContain('<script')
    expect(flat).not.toContain('onerror')
    // a tag split by another tag doesn't close up once the inner one goes
    expect(JSON.stringify(parseThreadText('<scr<b>ipt>alert(1)</scr</b>ipt>'))).not.toContain('<script')
    expect(out.flat().some((t) => t.kind === 'link' || t.kind === 'media')).toBe(false)
    // and a real link next to a script one keeps only the real one
    const mixed = parseInline('[a](javascript:alert(1)) https://ok.test/x')
    expect(mixed.filter((t) => t.kind === 'link')).toEqual([
      { kind: 'link', href: 'https://ok.test/x', text: 'https://ok.test/x' },
    ])
  })
})
