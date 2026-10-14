import { describe, expect, it } from 'vitest'
import { bugReport, redact } from '../bugReport'

describe('redact', () => {
  it('drops who and what, keeps the error and the bundle', () => {
    const out = redact(
      [
        'Failed to fetch dynamically imported module: https://media.example.com:8443/assets/Account-B1x2.js',
        'GET /api/files?server=1&path=Anime%2FShow failed',
        'mail to Chisato@DA.jp from 192.168.1.20:42380 and fe80::1:2',
        'open /home/someone/x and C:\\Users\\Someone\\y',
        'ENOENT /media/anime/Some Show/Season 01/e01.mkv',
        'Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36',
        'token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef and 0123456789abcdef0123456789abcdef',
      ].join('\n'),
    )
    expect(out).toContain('<origin>/assets/Account-B1x2.js')
    expect(out).toContain('?<query>')
    for (const gone of [
      'media.example.com',
      'Anime',
      'Chisato',
      '192.168',
      'fe80',
      'someone',
      'Someone',
      'Some Show',
      'eyJ',
      '0123456789abcdef',
    ])
      expect(out).not.toContain(gone)
    expect(out).toContain('ENOENT')
    expect(out).toContain('Chrome/141.0.0.0')
  })

  it('builds a report with the error and without the query', () => {
    history.pushState({}, '', '/files?path=secret-folder')
    const r = bugReport(new TypeError('x is undefined'), { version: '2026.10.1' })
    expect(r).toContain('TypeError: x is undefined')
    expect(r).toContain('Version: 2026.10.1')
    expect(r).toContain('Screen: /files?<query>')
    expect(r).toMatch(/Time: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/)
    expect(r).not.toContain('secret-folder')
  })
})
