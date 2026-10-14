import { describe, expect, it } from 'vitest'
import { csvToLines, linesToCsv } from '../pages/settings/Security'

describe('security lists', () => {
  it('shows a stored CSV one entry per line', () => {
    expect(csvToLines('10.0.0.0/8, 192.168.0.0/16')).toBe('10.0.0.0/8\n192.168.0.0/16')
    expect(csvToLines('')).toBe('')
  })

  it('keeps what is typed, a fresh line and a space inside a name included', () => {
    for (const typed of ['a\n', 'my group', 'admins\nmy ', '10.0.0.0/8\n\n172.16.0.0/12']) {
      expect(csvToLines(linesToCsv(typed))).toBe(typed)
    }
  })
})
