import { useId, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Dialog, Input, Panel } from '@weebsync/design-system'
import { api, type UserAccount } from '../../api'
import { useConfirm } from '../../components/confirm'
import { useAuth } from '../../hooks'
import type { SettingsState } from './useSettingsForm'

export default function Users() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { data: user } = useAuth()
  const meId = user?.id ?? 0
  const { data: settings } = useQuery<SettingsState>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
  })
  // when OIDC group mapping is set, the IdP owns roles - the backend
  // rejects local role changes with 409, so don't offer the toggle
  const rolesManagedByOidc = !!settings?.oidcAdminValues.trim()
  const { data: users } = useQuery<UserAccount[]>({
    queryKey: ['users'],
    queryFn: () => api.get('/api/users'),
  })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pwFor, setPwFor] = useState<UserAccount | null>(null)

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
    <Panel as="section" className="mb-4 p-5" aria-label={t('settings.users')}>
      <Badge tone="accent">{t('settings.users')}</Badge>
      {rolesManagedByOidc && <p className="mt-2 text-xs text-t-muted">{t('settings.rolesManagedByOidc')}</p>}
      <ul className="mt-3 grid grid-cols-1 gap-2">
        {(users ?? []).map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-2 border-b border-border-subtle pb-2 text-sm">
            {/* full row on phones so the address stays readable */}
            <span
              className="min-w-0 basis-full truncate font-mono text-xs text-t-secondary sm:flex-1 sm:basis-auto"
              title={u.email}
            >
              {u.email}
            </span>
            {u.id === meId && <Badge>{t('settings.usersYou')}</Badge>}
            {u.isAdmin && <Badge tone="accent">{t('settings.usersAdmin')}</Badge>}
            <Button size="sm" disabled={rolesManagedByOidc || toggle.isPending} onClick={() => toggle.mutate(u)}>
              {u.isAdmin ? t('settings.usersRemoveAdmin') : t('settings.usersMakeAdmin')}
            </Button>
            {settings?.authMode === 'password' && (
              <Button size="sm" onClick={() => setPwFor(u)}>
                {t('settings.usersSetPassword')}
              </Button>
            )}
            <Button
              size="sm"
              variant="danger"
              disabled={u.id === meId || del.isPending}
              onClick={async () => {
                if (await confirm({ message: t('settings.usersConfirmDelete', { email: u.email }), destructive: true }))
                  del.mutate(u.id)
              }}
            >
              {t('servers.delete')}
            </Button>
          </li>
        ))}
      </ul>
      {settings && settings.authMode !== 'password' ? (
        <p className="mt-4 text-xs text-t-muted">{t('settings.usersOidcOnly')}</p>
      ) : (
        <form
          className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate()
          }}
        >
          <label className="text-xs text-t-muted">
            {t('login.email')}
            <Input
              className="mt-1 font-mono"
              type="email"
              required
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="text-xs text-t-muted">
            {t('login.password')}
            <Input
              className="mt-1 font-mono"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <Button className="self-end" type="submit" disabled={create.isPending}>
            {t('settings.usersCreate')}
          </Button>
        </form>
      )}
      {error && (
        <p className="mt-2 text-xs text-err" role="alert">
          {error}
        </p>
      )}
      <p role="status" className="mt-2 text-xs text-ok empty:hidden">
        {notice}
      </p>
      {pwFor && (
        <SetPasswordDialog
          user={pwFor}
          onClose={(done) => {
            setPwFor(null)
            setNotice(done ? t('settings.usersPasswordSet', { email: pwFor.email }) : '')
          }}
        />
      )}
    </Panel>
  )
}

// An admin's way back in for someone who forgot their password: the new one
// replaces the old, and the account's sessions end.
function SetPasswordDialog({ user, onClose }: { user: UserAccount; onClose: (done: boolean) => void }) {
  const { t } = useTranslation()
  const titleId = useId()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.put(`/api/users/${user.id}/password`, { password })
      onClose(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
      setBusy(false)
    }
  }
  return (
    <Dialog onClose={() => onClose(false)} width="max-w-md" aria-labelledby={titleId}>
      <form onSubmit={submit}>
        <header className="border-b border-border-subtle px-5 py-4">
          <h3 id={titleId} className="font-display font-semibold tracking-wider">
            {t('settings.usersSetPasswordTitle', { email: user.email })}
          </h3>
        </header>
        <div className="space-y-2 px-5 py-4">
          <p className="text-sm text-t-secondary">{t('settings.usersSetPasswordHint')}</p>
          <label className="block text-xs text-t-muted">
            {t('account.passwordNew')}
            <Input
              className="mt-1 font-mono"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p className="text-xs text-err" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <Button type="button" onClick={() => onClose(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t('settings.usersSetPassword')}
          </Button>
        </footer>
      </form>
    </Dialog>
  )
}
