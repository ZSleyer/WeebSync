import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Checkbox } from 'fluid-lycoris'
import { api } from '../api'
import { scopeChanged, useScopeInfo } from './useCatalogView'

// The scope rule of a catalog folder, under its mark: a folder whose name
// varies ("2026-3 Summer") offers to mark the new folders beside it that look
// the same, and a folder a rule covers says so and can end the rule. Nothing
// shows for a folder without a mark or with a name that never varies. Ending
// a rule is rare, so it is a quiet link, not a button between the controls
// and the covers.
export default function ScopeRuleLine({
  serverId,
  path,
  kindLabel,
}: {
  serverId: number
  path: string
  /** the readable name of the folder's mark, e.g. "Anime (AniList)" */
  kindLabel: (kind: string) => string
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useScopeInfo(serverId, path)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!data?.scope) return null
  const name = path.split('/').pop() ?? ''

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      scopeChanged(qc, serverId)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  let body
  if (data.ruleId && data.ruleKind === data.scope) {
    body = (
      <>
        <span>{t('remote.scopeRuleActive', { kind: kindLabel(data.ruleKind) })}</span>
        <button
          type="button"
          className="t-link"
          disabled={busy}
          onClick={() => run(() => api.del(`/api/catalog/scope-rules/${data.ruleId}`))}
        >
          {t('remote.scopeRuleEnd')}
        </button>
      </>
    )
  } else if (data.ruleShape) {
    body = (
      <Checkbox
        checked={false}
        disabled={busy}
        labelClassName="text-xs"
        label={t('remote.scopeRuleOffer', { name, kind: kindLabel(data.scope) })}
        onChange={() =>
          run(() =>
            api.put(`/api/servers/${serverId}/catalog/scope`, { path: '/' + path, kind: data.scope, rule: true }),
          )
        }
      />
    )
  }
  if (!body) return null
  return (
    <div className="flex w-full flex-wrap items-center gap-2 text-xs text-t-muted">
      {body}
      {error && (
        <span className="text-err" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
