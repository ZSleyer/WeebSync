import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Settings as SettingsT } from '../api'

const ACCENTS = ['violet', 'acid', 'crimson', 'cyan', 'blue', 'green', 'pink', 'orange']

export default function Settings() {
  const qc = useQueryClient()
  const { data } = useQuery<SettingsT>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
  })
  const [form, setForm] = useState<SettingsT | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (data && !form) setForm(data)
  }, [data, form])

  const save = useMutation({
    mutationFn: (s: SettingsT) => api.put('/api/settings', s),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  // look & feel is client-side, persisted in localStorage
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'dark')
  const [accent, setAccent] = useState(document.documentElement.dataset.accent ?? 'violet')
  const [motion, setMotion] = useState(document.documentElement.dataset.motion !== 'off')

  const applyLook = (t: string, a: string, m: boolean) => {
    const root = document.documentElement
    root.dataset.theme = t
    root.dataset.accent = a
    if (m) delete root.dataset.motion
    else root.dataset.motion = 'off'
    localStorage.setItem('weebsync.theme', t)
    localStorage.setItem('weebsync.accent', a)
    localStorage.setItem('weebsync.motion', m ? 'on' : 'off')
  }

  return (
    <div className="max-w-2xl">
      <header className="mb-6">
        <h2 className="font-display text-xl font-semibold tracking-wider">SETTINGS</h2>
        <span className="t-label mt-1">transfers · look · account</span>
      </header>

      <section className="t-panel mb-4 p-5" aria-label="Transfer-Einstellungen">
        <span className="t-label t-label--accent mb-4">transfers</span>
        {form && (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <label className="text-xs text-t-muted">
              Parallele Downloads (1–20)
              <input
                className="t-input mt-1 font-mono"
                type="number"
                min={1}
                max={20}
                value={form.maxConcurrent}
                onChange={(e) => setForm({ ...form, maxConcurrent: Number(e.target.value) })}
              />
            </label>
            <label className="text-xs text-t-muted">
              Globales Speed-Limit (KiB/s, 0 = unbegrenzt)
              <input
                className="t-input mt-1 font-mono"
                type="number"
                min={0}
                value={Math.round(form.globalRateLimit / 1024)}
                onChange={(e) => setForm({ ...form, globalRateLimit: Number(e.target.value) * 1024 })}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-t-secondary sm:col-span-2">
              <input
                type="checkbox"
                checked={form.registrationDisabled}
                onChange={(e) => setForm({ ...form, registrationDisabled: e.target.checked })}
              />
              Registrierung deaktivieren
            </label>
            <div className="flex items-center gap-3 sm:col-span-2">
              <button className="t-btn t-btn--primary t-cut" onClick={() => save.mutate(form)} disabled={save.isPending}>
                Speichern
              </button>
              {saved && <span className="t-label t-label--ok">gespeichert</span>}
              {save.error && <span className="text-sm text-err">{(save.error as Error).message}</span>}
            </div>
          </div>
        )}
      </section>

      <section className="t-panel p-5" aria-label="Darstellung">
        <span className="t-label t-label--accent mb-4">look</span>
        <div className="mt-3 grid gap-4">
          <div role="group" aria-label="Theme" className="flex items-center gap-2">
            <span className="w-24 text-xs text-t-muted">Theme</span>
            {(['dark', 'light'] as const).map((t) => (
              <button
                key={t}
                className={`t-btn t-btn--sm ${theme === t ? 't-btn--primary' : ''}`}
                aria-pressed={theme === t}
                onClick={() => {
                  setTheme(t)
                  applyLook(t, accent, motion)
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Akzentfarbe" className="flex items-center gap-2">
            <span className="w-24 text-xs text-t-muted">Akzent</span>
            <div className="flex flex-wrap gap-2">
              {ACCENTS.map((a) => (
                <button
                  key={a}
                  title={a}
                  aria-pressed={accent === a}
                  aria-label={`Akzent ${a}`}
                  className={`h-6 w-6 border ${accent === a ? 'border-t-primary outline outline-2 outline-accent' : 'border-border-subtle'}`}
                  style={{ backgroundColor: `var(--accent-blue)` }}
                  data-accent={a}
                  onClick={() => {
                    setAccent(a)
                    applyLook(theme, a, motion)
                  }}
                />
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-t-secondary">
            <input
              type="checkbox"
              checked={motion}
              onChange={(e) => {
                setMotion(e.target.checked)
                applyLook(theme, accent, e.target.checked)
              }}
            />
            Animationen aktiviert
          </label>
        </div>
      </section>
    </div>
  )
}
