import { describe, expect, it } from 'vitest'
import { netErrorText } from '../api'
import i18n from '../locales'

describe('netErrorText', () => {
  it('says a refused connection in words', async () => {
    await i18n.changeLanguage('de')
    expect(netErrorText('dial tcp 127.0.0.1:1: connect: connection refused')).toBe(
      'Der Server ist nicht erreichbar, er lehnt die Verbindung ab.',
    )
  })

  it('knows timeouts, unknown hosts and refused sign-ins', async () => {
    await i18n.changeLanguage('en')
    expect(netErrorText('dial tcp 10.0.0.2:22: i/o timeout')).toBe('The server does not answer in time.')
    expect(netErrorText('dial tcp: lookup nas.example.com: no such host')).toBe('The server name cannot be resolved.')
    expect(netErrorText('ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password]')).toBe(
      'The server refused the sign-in.',
    )
  })

  it('leaves any other text as it is', () => {
    expect(netErrorText('the target folder is not allowed')).toBe('the target folder is not allowed')
  })
})
