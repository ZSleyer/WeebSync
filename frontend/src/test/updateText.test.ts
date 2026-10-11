import { describe, expect, it } from 'vitest'
import { updateText, type VersionInfo } from '../hooks'

// t echoes key plus options, so the assertion reads which key spoke
const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key)
const v = (channel: string, latest: string) => ({ channel, latest }) as VersionInfo

describe('updateText', () => {
  it('names a release by its number', () => {
    expect(updateText(t, v('stable', '2026.11.1'))).toBe('about.updateStable {"version":"2026.11.1"}')
  })
  it('names a build by its channel and commit', () => {
    expect(updateText(t, v('nightly', 'abc1234'))).toBe(
      'about.updateBuild {"channel":"about.channel.nightly","sha":"abc1234"}',
    )
    expect(updateText(t, v('dev', 'def5678'))).toBe('about.updateBuild {"channel":"about.channel.dev","sha":"def5678"}')
  })
})
