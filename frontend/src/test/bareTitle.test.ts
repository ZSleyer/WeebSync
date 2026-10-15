import { describe, expect, it } from 'vitest'
import { bareTitle } from '../pages/PlayerInfo'

describe('bareTitle', () => {
  it('drops the extension and the tags around the name', () => {
    expect(bareTitle('Clevatess II E02 [1080p][AAC][GerJapDub][GerEngSub][Web-DL].mkv')).toBe('Clevatess II E02')
    expect(bareTitle('[SubsPlease] Sousou no Frieren - 03 (1080p) [A1B2C3D4].mkv')).toBe('Sousou no Frieren - 03')
    expect(bareTitle('Some_Show_-_05_[720p].mp4')).toBe('Some Show - 05')
  })
  it('keeps a name that is nothing but tags', () => {
    expect(bareTitle('[1080p].mkv')).toBe('[1080p]')
  })
})
