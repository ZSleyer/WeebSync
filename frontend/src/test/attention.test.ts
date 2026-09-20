import { describe, expect, it } from 'vitest'
import { langLabel, type Watch } from '../api'
import { attentionInfo, dubOverdueLabel, dubWaitingLabel } from '../attention'

// the i18n layer is not under test: t returns key plus options, so every
// assertion reads which key spoke and with what
const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key)

const watch = (over: Partial<Watch>): Watch => ({ wantDub: 'Ger', wantSub: '', ...over }) as Watch

describe('langLabel', () => {
  it('names dub, sub or both', () => {
    expect(langLabel({ wantDub: 'Ger', wantSub: '' })).toBe('Ger-Dub')
    expect(langLabel({ wantDub: '', wantSub: 'Ger' })).toBe('Ger-Sub')
    expect(langLabel({ wantDub: 'Ger', wantSub: 'Eng' })).toBe('Ger-Dub/Eng-Sub')
    expect(langLabel({ wantDub: '', wantSub: '' })).toBe('')
  })
})

describe('dub waiting labels', () => {
  it('dates the wait when the forecast has a date', () => {
    expect(dubWaitingLabel(t, watch({ dubExpectedAt: 1_800_000_000 }))).toContain('watch.dubWaiting ')
    expect(dubWaitingLabel(t, watch({}))).toBe('watch.dubWaitingNoDate {"lang":"Ger-Dub"}')
  })
  it('speaks overdue with and without a date', () => {
    expect(dubOverdueLabel(t, watch({ dubExpectedAt: 1_800_000_000 }))).toContain('watch.dubOverdue ')
    expect(dubOverdueLabel(t, watch({}))).toBe('watch.dubOverdueNoDate {"lang":"Ger-Dub"}')
  })
})

describe('attentionInfo', () => {
  it('renders exactly the reasons the backend sent, in order', () => {
    const w = watch({
      attention: ['checkFailed', 'behind', 'missing', 'langWaiting'],
      lastResult: 'boom',
      behind: 2,
      missing: [4],
      langWaiting: 3,
    })
    const chips = attentionInfo(t, w)
    expect(chips.map((c) => c.key)).toEqual(['checkFailed', 'behind', 'missing', 'langWaiting'])
    expect(chips[0]).toEqual({ key: 'checkFailed', tone: 'err', text: 'dash.checkFailed' })
    expect(chips[1].text).toBe('watch.behind {"count":2}')
    expect(chips[3].text).toBe('watch.langWaiting {"count":3,"lang":"Ger-Dub"}')
  })
  it('is empty when the backend saw nothing', () => {
    expect(attentionInfo(t, watch({}))).toEqual([])
    // a dub watch whose waiting the forecast explains sends no attention at
    // all - the suppression lives in the backend, not here
    expect(attentionInfo(t, watch({ langWaiting: 3, dubWaiting: true }))).toEqual([])
  })
  it('speaks the plex miss in words', () => {
    const chips = attentionInfo(t, watch({ attention: ['plexStreamMiss'], plexStreamMiss: 'audio,sub' }))
    expect(chips[0].text).toBe('watch.plexMiss {"what":"watch.plexAudio, watch.plexSub"}')
  })
})
