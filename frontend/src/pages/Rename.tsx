import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type Media, type RenamePair } from '../api'
import { LocalPicker } from '../components/FileBrowser'

const PRESETS = [
  { key: 'rename.presetPlex', template: '{title} - S{season:02}E{episode:02}' },
  { key: 'rename.presetCompact', template: '{title}.S{season:02}E{episode:02}' },
  { key: 'rename.presetGroup', template: '[{group}] {title} - {episode:02}' },
]

export default function Rename() {
  const { t } = useTranslation()
  const [path, setPath] = useState('')
  const [mode, setMode] = useState<'template' | 'regex'>('template')
  const [template, setTemplate] = useState(PRESETS[0].template)
  const [separator, setSeparator] = useState('_')
  const [titleOverride, setTitleOverride] = useState('')
  const [pattern, setPattern] = useState('')
  const [replacement, setReplacement] = useState('')
  const [preview, setPreview] = useState<RenamePair[] | null>(null)
  const [applied, setApplied] = useState<RenamePair[] | null>(null)

  const body = { path, mode, template, separator, titleOverride, pattern, replacement }

  const doPreview = useMutation({
    mutationFn: () => api.post<RenamePair[]>('/api/rename/preview', body),
    onSuccess: (r) => {
      setPreview(r)
      setApplied(null)
    },
  })

  const doApply = useMutation({
    mutationFn: () =>
      api.post<RenamePair[]>('/api/rename/apply', {
        path,
        renames: preview!.filter((p) => !p.error && p.old !== p.new),
      }),
    onSuccess: (r) => {
      setApplied(r)
      setPreview(null)
    },
  })

  return (
    <div>
      <header className="mb-6">
        <h2 className="font-display text-xl font-semibold tracking-wider">{t('rename.title')}</h2>
        <span className="t-label mt-1">{t('rename.sub')}</span>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(16rem,0.5fr)_1fr]">
        <section className="t-panel flex h-96 flex-col" aria-label={t('rename.folderSection')}>
          <div className="border-b border-border-subtle px-3 py-2">
            <span className="t-label">
              {t('rename.folder')}: downloads/{path}
            </span>
          </div>
          <LocalPicker path={path} onNavigate={setPath} />
        </section>

        <section className="t-panel p-4" aria-label={t('rename.rules')}>
          <div role="group" aria-label={t('rename.mode')} className="mb-4 flex">
            <button
              className={`t-btn t-btn--sm ${mode === 'template' ? 't-btn--primary' : ''}`}
              aria-pressed={mode === 'template'}
              onClick={() => setMode('template')}
            >
              {t('rename.template')}
            </button>
            <button
              className={`t-btn t-btn--sm ${mode === 'regex' ? 't-btn--primary' : ''}`}
              aria-pressed={mode === 'regex'}
              onClick={() => setMode('regex')}
            >
              {t('rename.regex')}
            </button>
          </div>

          {mode === 'template' ? (
            <div className="grid gap-3">
              <label className="text-xs text-t-muted">
                {t('rename.templateLabel')}
                <input className="t-input mt-1 font-mono" value={template} onChange={(e) => setTemplate(e.target.value)} />
              </label>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <button key={p.key} className="t-btn t-btn--sm" onClick={() => setTemplate(p.template)}>
                    {t(p.key)}
                  </button>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-t-muted">
                  {t('rename.separator')}
                  <span className="t-select-wrap mt-1">
                    <select className="t-select font-mono" value={separator} onChange={(e) => setSeparator(e.target.value)}>
                      <option value=" ">{t('rename.sepSpace')}</option>
                      <option value="_">{t('rename.sepUnderscore')}</option>
                      <option value=".">{t('rename.sepDot')}</option>
                      <option value="-">{t('rename.sepDash')}</option>
                    </select>
                  </span>
                </label>
                <TitleSearch value={titleOverride} onChange={setTitleOverride} />
              </div>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-t-muted">
                {t('rename.pattern')}
                <input
                  className="t-input mt-1 font-mono"
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder={'\\.S(\\d+)E(\\d+)\\.'}
                />
              </label>
              <label className="text-xs text-t-muted">
                {t('rename.replacement')}
                <input
                  className="t-input mt-1 font-mono"
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  placeholder=" - S${1}E${2}."
                />
              </label>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button className="t-btn" onClick={() => doPreview.mutate()} disabled={doPreview.isPending}>
              {t('rename.preview')}
            </button>
            <button
              className="t-btn t-btn--primary t-cut"
              disabled={!preview || preview.every((p) => p.error || p.old === p.new) || doApply.isPending}
              onClick={() => doApply.mutate()}
            >
              {t('rename.apply')}
            </button>
          </div>
          {(doPreview.error || doApply.error) && (
            <p className="mt-3 text-sm text-err" role="alert">
              {((doPreview.error ?? doApply.error) as Error).message}
            </p>
          )}
        </section>
      </div>

      {(preview ?? applied) && (
        <section className="t-panel mt-4 overflow-x-auto" aria-label={t('rename.result')}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left">
                <th className="px-3 py-2">
                  <span className="t-label">{t('rename.old')}</span>
                </th>
                <th className="px-3 py-2">
                  <span className="t-label">{applied ? t('rename.applied') : t('rename.new')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              {(preview ?? applied)!.map((p, i) => (
                <tr key={i} className="border-b border-border-subtle/50">
                  <td className="px-3 py-1.5 text-t-muted">{p.old}</td>
                  <td
                    className={`px-3 py-1.5 ${p.error ? 'text-err' : p.old === p.new ? 'text-t-muted' : applied ? 'text-ok' : 'text-accent'}`}
                  >
                    {p.error ? `⚠ ${p.error}` : p.old === p.new ? t('rename.unchanged') : p.new}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

// AniList search box that fills the title override. Fully keyboard
// accessible: results are focusable buttons, the list closes only when
// focus leaves the whole widget (WCAG 2.1.1).
function TitleSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation()
  const [results, setResults] = useState<Media[]>([])
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  const search = async (q: string) => {
    onChange(q)
    if (q.length < 3) {
      setResults([])
      setOpen(false)
      return
    }
    try {
      setResults(await api.get<Media[]>(`/api/anilist/search?q=${encodeURIComponent(q)}`))
      setOpen(true)
    } catch {
      /* ignore */
    }
  }

  const pick = (m: Media) => {
    onChange(m.title.romaji)
    setOpen(false)
  }

  return (
    <div
      ref={wrap}
      className="relative text-xs text-t-muted"
      onBlur={(e) => {
        if (!wrap.current?.contains(e.relatedTarget as Node)) setOpen(false)
      }}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
    >
      <label>
        {t('rename.titleOverride')}
        <input
          className="t-input mt-1"
          value={value}
          placeholder={t('rename.titlePlaceholder')}
          aria-expanded={open}
          onChange={(e) => search(e.target.value)}
        />
      </label>
      {open && results.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-50 max-h-48 overflow-y-auto border border-border-subtle bg-bg-card shadow-lg">
          {results.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="block w-full truncate px-3 py-1.5 text-left text-sm text-t-secondary hover:bg-bg-hover"
                onClick={() => pick(m)}
              >
                {m.title.romaji} <span className="text-t-muted">({m.seasonYear})</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
