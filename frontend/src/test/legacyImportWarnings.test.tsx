import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import LegacyImport, { type LegacyPlan } from '../components/LegacyImport'
import i18n from '../locales'

const WARNINGS = ['legacyWarnDroppedGroups', 'legacyWarnConditional', 'legacyWarnFilterDropped', 'legacyWarnNoPattern']

const plan: LegacyPlan = {
  server: {
    name: 'old',
    protocol: 'ftp',
    host: 'h.example.com',
    port: 22,
    username: 'u',
    oldPort: 21,
    hasPassword: false,
  },
  watches: [
    {
      id: 'w1',
      remotePath: '/anime/Show',
      localPath: '/media/Show',
      mode: 'template',
      template: '{title} - {episode}',
      titleOverride: '',
      pattern: '',
      replacement: '',
      fromEpisode: 0,
      offset: 0,
      warnings: WARNINGS,
    },
  ],
  intervalMin: 30,
  warnings: ['legacyWarnFtp'],
}

vi.mock(import('../api'), async (importOriginal) => ({
  ...(await importOriginal()),
  api: { get: vi.fn(async () => []), post: vi.fn(async () => plan) } as never,
}))

describe('LegacyImport warnings', () => {
  for (const lang of ['de', 'en']) {
    it(`shows every conversion warning as translated text (${lang})`, async () => {
      await i18n.changeLanguage(lang)
      const { container } = render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <LegacyImport />
        </QueryClientProvider>,
      )
      const file = new File(['{"server":{}}'], 'config.json', { type: 'application/json' })
      fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } })
      await waitFor(() => expect(container.querySelector('input[name=port]')).not.toBeNull())
      for (const key of WARNINGS) {
        const text = i18n.t(`legacy.${key}`)
        expect(text).not.toBe(`legacy.${key}`)
        expect(screen.getByText(text)).toBeInTheDocument()
      }
      // the plan-level FTP warning is the note on top, with the old port
      expect(screen.getByRole('note')).toHaveTextContent('21')
      expect(container.textContent).not.toMatch(/legacyWarn/)
    })
  }
})
