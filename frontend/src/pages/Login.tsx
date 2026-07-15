import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type AuthConfig, type User } from '../api'

export default function Login() {
  const qc = useQueryClient()
  const { data: cfg } = useQuery<AuthConfig>({
    queryKey: ['authConfig'],
    queryFn: () => api.get('/api/auth/config'),
  })
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.post<User>(`/api/auth/${mode}`, { email, password })
      await qc.invalidateQueries({ queryKey: ['me'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unbekannter Fehler')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="t-hatch grid min-h-screen place-items-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="font-display text-3xl font-bold tracking-[0.25em]">
            WEEB<span className="text-accent">SYNC</span>
          </h1>
          <span className="t-label mt-3">s/ftp anime sync · private use</span>
        </div>
        <form className="t-panel animate-fadeIn p-6" onSubmit={submit}>
          <div className="mb-4 flex gap-1" role="tablist" aria-label="Login oder Registrierung">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={`t-btn t-btn--sm flex-1 ${mode === 'login' ? 't-btn--primary t-cut' : ''}`}
              onClick={() => setMode('login')}
            >
              Login
            </button>
            {cfg?.registrationOpen && (
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'register'}
                className={`t-btn t-btn--sm flex-1 ${mode === 'register' ? 't-btn--primary t-cut' : ''}`}
                onClick={() => setMode('register')}
              >
                Registrieren
              </button>
            )}
          </div>
          <label className="t-label mb-1 block w-fit" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="t-input mb-4"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label className="t-label mb-1 block w-fit" htmlFor="password">
            Passwort
          </label>
          <input
            id="password"
            className="t-input mb-4"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={mode === 'register' ? 10 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <p className="mb-3 border border-err/40 px-3 py-2 text-sm text-err" role="alert">
              {error}
            </p>
          )}
          <button className="t-btn t-btn--primary t-cut w-full" disabled={busy}>
            {mode === 'login' ? 'Anmelden' : 'Konto anlegen'}
          </button>
          {cfg?.oidc && (
            <a className="t-btn mt-3 block w-full text-center" href="/api/auth/oidc/login">
              Mit OIDC anmelden
            </a>
          )}
        </form>
      </div>
    </div>
  )
}
