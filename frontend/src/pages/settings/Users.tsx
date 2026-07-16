import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type UserAccount } from '../../api'
import { useAuth } from '../../hooks'
import type { SettingsState } from './useSettingsForm'

export default function Users() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: user } = useAuth()
  const meId = user?.id ?? 0
  const { data: settings } = useQuery<SettingsState>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
  })
  // when OIDC group mapping is set, the IdP owns roles — the backend
  // rejects local role changes with 409, so don't offer the toggle
  const rolesManagedByOidc = !!settings?.oidcAdminValues.trim()
  const { data: users } = useQuery<UserAccount[]>({
    queryKey: ['users'],
    queryFn: () => api.get('/api/users'),
  })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const opts = {
    onSuccess: () => {
      setError('')
      qc.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e: Error) => setError(e.message),
  }
  const create = useMutation({
    mutationFn: () => api.post('/api/users', { email, password }),
    ...opts,
    onSuccess: () => {
      setEmail('')
      setPassword('')
      opts.onSuccess()
    },
  })
  const toggle = useMutation({
    mutationFn: (u: UserAccount) => api.put(`/api/users/${u.id}`, { isAdmin: !u.isAdmin }),
    ...opts,
    onSuccess: () => {
      // self-demotion changes what the shell may render (admin nav/routes)
      qc.invalidateQueries({ queryKey: ['me'] })
      opts.onSuccess()
    },
  })
  const del = useMutation({
    mutationFn: (id: number) => api.del(`/api/users/${id}`),
    ...opts,
  })

  return (
    <section className="t-panel mb-4 p-5" aria-label={t('settings.users')}>
      <span className="t-label t-label--accent">{t('settings.users')}</span>
      {rolesManagedByOidc && (
        <p className="mt-2 text-xs text-t-muted">{t('settings.rolesManagedByOidc')}</p>
      )}
      <ul className="mt-3 grid grid-cols-1 gap-2">
        {(users ?? []).map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-2 border-b border-border-subtle pb-2 text-sm">
            {/* full row on phones so the address stays readable */}
            <span className="min-w-0 basis-full truncate font-mono text-xs text-t-secondary sm:flex-1 sm:basis-auto" title={u.email}>
              {u.email}
            </span>
            {u.id === meId && <span className="t-label">{t('settings.usersYou')}</span>}
            {u.isAdmin && <span className="t-label t-label--accent">{t('settings.usersAdmin')}</span>}
            <button
              className="t-btn t-btn--sm"
              disabled={rolesManagedByOidc || toggle.isPending}
              onClick={() => toggle.mutate(u)}
            >
              {u.isAdmin ? t('settings.usersRemoveAdmin') : t('settings.usersMakeAdmin')}
            </button>
            <button
              className="t-btn t-btn--sm t-btn--danger"
              disabled={u.id === meId || del.isPending}
              onClick={() => {
                if (confirm(t('settings.usersConfirmDelete', { email: u.email }))) del.mutate(u.id)
              }}
            >
              {t('servers.delete')}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <label className="text-xs text-t-muted">
          {t('login.email')}
          <input
            className="t-input mt-1 font-mono"
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="text-xs text-t-muted">
          {t('login.password')}
          <input
            className="t-input mt-1 font-mono"
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className="t-btn self-end" type="submit" disabled={create.isPending}>
          {t('settings.usersCreate')}
        </button>
      </form>
      {error && (
        <p className="mt-2 text-xs text-err" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
