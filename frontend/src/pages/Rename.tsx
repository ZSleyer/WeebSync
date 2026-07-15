import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api, type Media, type RenamePair } from '../api'
import { LocalPicker } from '../components/FileBrowser'

const PRESETS = [
  { label: 'Plex: Series - S01E01', template: '{title} - S{season:02}E{episode:02}' },
  { label: 'Kompakt: Series.S01E01', template: '{title}.S{season:02}E{episode:02}' },
  { label: 'Mit Gruppe: [Group] Series - 01', template: '[{group}] {title} - {episode:02}' },
]

export default function Rename() {
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
        <h2 className="font-display text-xl font-semibold tracking-wider">RENAME</h2>
        <span className="t-label mt-1">template · regex · anilist</span>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(16rem,0.5fr)_1fr]">
        <section className="t-panel flex h-96 flex-col" aria-label="Ordnerwahl">
          <div className="border-b border-border-subtle px-3 py-2">
            <span className="t-label">ordner: downloads/{path}</span>
          </div>
          <LocalPicker path={path} onNavigate={setPath} />
        </section>

        <section className="t-panel p-4" aria-label="Regeln">
          <div role="group" aria-label="Modus" className="mb-4 flex">
            <button
              className={`t-btn t-btn--sm ${mode === 'template' ? 't-btn--primary' : ''}`}
              aria-pressed={mode === 'template'}
              onClick={() => setMode('template')}
            >
              Template
            </button>
            <button
              className={`t-btn t-btn--sm ${mode === 'regex' ? 't-btn--primary' : ''}`}
              aria-pressed={mode === 'regex'}
              onClick={() => setMode('regex')}
            >
              RegEx
            </button>
          </div>

          {mode === 'template' ? (
            <div className="grid gap-3">
              <label className="text-xs text-t-muted">
                Template — Variablen: {'{title} {season:02} {episode:02} {year} {group} {resolution}'}
                <input className="t-input mt-1 font-mono" value={template} onChange={(e) => setTemplate(e.target.value)} />
              </label>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <button key={p.label} className="t-btn t-btn--sm" onClick={() => setTemplate(p.template)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-t-muted">
                  Trennzeichen (ersetzt Leerzeichen)
                  <span className="t-select-wrap mt-1">
                    <select className="t-select font-mono" value={separator} onChange={(e) => setSeparator(e.target.value)}>
                      <option value=" ">Leerzeichen</option>
                      <option value="_">_ Unterstrich</option>
                      <option value=".">. Punkt</option>
                      <option value="-">- Bindestrich</option>
                    </select>
                  </span>
                </label>
                <TitleSearch value={titleOverride} onChange={setTitleOverride} />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-t-muted">
                Pattern (Go-RegEx)
                <input
                  className="t-input mt-1 font-mono"
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder={'\\.S(\\d+)E(\\d+)\\.'}
                />
              </label>
              <label className="text-xs text-t-muted">
                Ersetzung ($1, ${'{name}'})
                <input
                  className="t-input mt-1 font-mono"
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  placeholder=" - S${1}E${2}."
                />
              </label>
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <button className="t-btn" onClick={() => doPreview.mutate()} disabled={doPreview.isPending}>
              Vorschau (Dry-Run)
            </button>
            <button
              className="t-btn t-btn--primary t-cut"
              disabled={!preview || preview.every((p) => p.error || p.old === p.new) || doApply.isPending}
              onClick={() => doApply.mutate()}
            >
              Anwenden
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
        <section className="t-panel mt-4 overflow-x-auto" aria-label="Ergebnis">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left">
                <th className="px-3 py-2"><span className="t-label">alt</span></th>
                <th className="px-3 py-2"><span className="t-label">{applied ? 'ergebnis' : 'neu (vorschau)'}</span></th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              {(preview ?? applied)!.map((p, i) => (
                <tr key={i} className="border-b border-border-subtle/50">
                  <td className="px-3 py-1.5 text-t-muted">{p.old}</td>
                  <td className={`px-3 py-1.5 ${p.error ? 'text-err' : p.old === p.new ? 'text-t-faint' : applied ? 'text-ok' : 'text-accent'}`}>
                    {p.error ? `⚠ ${p.error}` : p.old === p.new ? 'unverändert' : p.new}
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

// AniList search box that fills the title override.
function TitleSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [results, setResults] = useState<Media[]>([])
  const [open, setOpen] = useState(false)
  const search = async (q: string) => {
    onChange(q)
    if (q.length < 3) {
      setResults([])
      return
    }
    try {
      setResults(await api.get<Media[]>(`/api/anilist/search?q=${encodeURIComponent(q)}`))
      setOpen(true)
    } catch {
      /* ignore */
    }
  }
  return (
    <label className="relative text-xs text-t-muted">
      Titel-Override (AniList)
      <input
        className="t-input mt-1"
        value={value}
        placeholder="optional — Serientitel"
        onChange={(e) => search(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && results.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-50 max-h-48 overflow-y-auto border border-border-subtle bg-bg-card shadow-lg">
          {results.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="block w-full truncate px-3 py-1.5 text-left text-sm text-t-secondary hover:bg-bg-hover"
                onMouseDown={() => {
                  onChange(m.title.romaji)
                  setOpen(false)
                }}
              >
                {m.title.romaji} <span className="text-t-faint">({m.seasonYear})</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </label>
  )
}
