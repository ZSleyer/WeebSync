import { useId, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Dialog, Input, Row, RowAction, Rows, SettingsField } from 'fluid-lycoris'
import { api, type UserAccount } from '../../api'
import { useConfirm } from '../../components/confirm'
import { useAuth } from '../../hooks'
import type { SettingsState } from './useSettingsForm'
import { SettingsPanel } from './ui'
import './security.css'

export default function Users() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { data: user } = useAuth()
  const meId = user?.id ?? 0
  const emailId = useId()
  const pwId = useId()
  const { data: settings } = useQuery<SettingsState>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
  })
  // when OIDC group mapping is set, the IdP owns roles - the backend
  // rejects local role changes with 409, so don't offer the toggle
  const rolesManagedByOidc = !!settings?.oidcAdminValues.trim()
  const passwordMode = settings?.authMode === 'password'
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
    mutationFn: (body: { email: string; password: string }) => api.post('/api/users', body),
    ...opts,
    onMutate: () => setNotice(''),
    onSuccess: (_, body) => {
      setEmail('')
      setPassword('')
      // the form just empties itself; say what happened
      setNotice(t('settings.usersCreated', { email: body.email }))
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

  // how accounts sign in and where their role comes from: the instance's
  // mode, the API has no per-account method
  const via = passwordMode
    ? t('settings.usersViaPassword')
    : t('settings.usersViaOidc', { name: settings?.oidcProviderName || 'OIDC' })
  const role = rolesManagedByOidc
    ? t('settings.usersRoleFromGroup', { groups: settings?.oidcAdminValues.split(',').join(', ') })
    : ''

  return (
    <SettingsPanel id="users" title={t('settings.users')}>
      <Rows>
        {(users ?? []).map((u) => (
          <Row
            key={u.id}
            title={
              <span className="ws-user-t">
                <span className="min-w-0 truncate" title={u.email}>
                  {u.email}
                </span>
                {u.id === meId && <Badge>{t('settings.usersYou')}</Badge>}
                {u.isAdmin && <Badge tone="ok">{t('settings.usersAdmin')}</Badge>}
                {!u.emailVerified && <Badge tone="warn">{t('settings.usersUnverified')}</Badge>}
              </span>
            }
            sub={[via, role].filter(Boolean).join(' · ')}
            trailing={
              <span className="ws-user-acts">
                {!rolesManagedByOidc && (
                  <RowAction
                    disabled={toggle.isPending}
                    onClick={async () => {
                      // demoting yourself takes this very page away at once: ask first
                      if (
                        u.id === meId &&
                        u.isAdmin &&
                        !(await confirm({
                          message: t('settings.usersConfirmSelfDemote'),
                          confirmLabel: t('settings.usersRemoveAdmin'),
                          destructive: true,
                        }))
                      )
                        return
                      toggle.mutate(u)
                    }}
                  >
                    {u.isAdmin ? t('settings.usersRemoveAdmin') : t('settings.usersMakeAdmin')}
                  </RowAction>
                )}
                {passwordMode && <RowAction onClick={() => setPwFor(u)}>{t('settings.usersSetPassword')}</RowAction>}
                {u.id !== meId && (
                  <RowAction
                    className="text-err"
                    disabled={del.isPending}
                    onClick={async () => {
                      if (
                        await confirm({
                          message: t('settings.usersConfirmDelete', { email: u.email }),
                          destructive: true,
                        })
                      )
                        del.mutate(u.id)
                    }}
                  >
                    {t('servers.delete')}
                  </RowAction>
                )}
              </span>
            }
          />
        ))}
      </Rows>
      {rolesManagedByOidc && <p className="sf-note">{t('settings.rolesManagedByOidc')}</p>}
      {settings && !passwordMode ? (
        <p className="sf-note">{t('settings.usersOidcOnly')}</p>
      ) : (
        <form
          className="ws-user-new"
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate({ email, password })
          }}
        >
          <SettingsField label={t('login.email')} htmlFor={emailId}>
            <Input
              id={emailId}
              className="font-mono"
              type="email"
              required
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </SettingsField>
          <SettingsField label={t('login.password')} htmlFor={pwId}>
            <Input
              id={pwId}
              className="font-mono"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </SettingsField>
          <Button type="submit" disabled={create.isPending}>
            {t('settings.usersCreate')}
          </Button>
        </form>
      )}
      {error && (
        <p className="sf-issue mt-2" role="alert">
          {error}
        </p>
      )}
      <p role="status" className="t-sf-h mt-2 text-ok empty:hidden">
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
    </SettingsPanel>
  )
}

// An admin's way back in for someone who forgot their password: the new one
// replaces the old, and the account's sessions end.
function SetPasswordDialog({ user, onClose }: { user: UserAccount; onClose: (done: boolean) => void }) {
  const { t } = useTranslation()
  const titleId = useId()
  const pwId = useId()
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
      <form onSubmit={submit} className="ws-form-dlg">
        <div className="ws-form-dlg-bd">
          <h2 id={titleId}>{t('settings.usersSetPasswordTitle', { email: user.email })}</h2>
          <p className="sf-note">{t('settings.usersSetPasswordHint')}</p>
          <SettingsField label={t('account.passwordNew')} htmlFor={pwId}>
            <Input
              id={pwId}
              className="font-mono"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </SettingsField>
          {error && (
            <p className="sf-issue" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="ws-dlg-foot">
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
