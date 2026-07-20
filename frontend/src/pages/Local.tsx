import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type Entry } from '../api'
import { FileBrowser } from '../components/FileBrowser'
import { useConfirm } from '../components/confirm'
import { usePrompt } from '../components/prompt'
import { useAuth } from '../hooks'

// Local files as a page of their own: see what actually landed on disk and
// tidy it up. Writing is admin-only and always goes through a blocking modal,
// because rename and delete cannot be undone.
export default function Local() {
  const { t } = useTranslation()
  const { data: user } = useAuth()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const prompt = usePrompt()
  const [path, setPath] = useState('')
  const [error, setError] = useState('')

  const refresh = () => qc.invalidateQueries({ queryKey: ['local'] })

  const rename = async (e: Entry) => {
    const name = await prompt({
      title: t('local.renameTitle', { name: e.name }),
      defaultValue: e.name,
      confirmLabel: t('local.rename'),
    })
    if (!name || name === e.name) return
    setError('')
    try {
      await api.post('/api/browse/local/rename', { path: e.path, name })
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    }
  }

  const remove = async (e: Entry) => {
    const ok = await confirm({
      message: e.isDir ? t('local.deleteDirConfirm', { name: e.name }) : t('local.deleteConfirm', { name: e.name }),
      confirmLabel: t('local.delete'),
      destructive: true,
    })
    if (!ok) return
    setError('')
    try {
      // recursive only for directories: a folder the user confirmed goes
      // completely, a file needs no flag
      await api.del('/api/browse/local', { path: e.path, recursive: e.isDir })
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    }
  }

  // rename/delete buttons per row. Admins only; everyone else just reads.
  const actions = (e: Entry) =>
    user?.isAdmin ? (
      <span className="my-1 mr-2 flex shrink-0 gap-1.5">
        <button
          type="button"
          className="t-btn t-btn--sm"
          aria-label={t('local.renameItem', { name: e.name })}
          title={t('local.rename')}
          onClick={() => rename(e)}
        >
          ✎
        </button>
        <button
          type="button"
          className="t-btn t-btn--sm t-btn--danger"
          aria-label={t('local.deleteItem', { name: e.name })}
          title={t('local.delete')}
          onClick={() => remove(e)}
        >
          ✕
        </button>
      </span>
    ) : undefined

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col lg:h-[calc(100vh-3rem)]">
      <header className="mb-4">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('local.title')}</h2>
          <span className="t-label mt-1">{t('local.sub')}</span>
        </div>
      </header>

      <section className="t-panel flex min-h-64 min-w-0 flex-col lg:min-h-0" aria-label={t('local.title')}>
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          <span className="t-label t-label--accent">{t('browser.local')}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-t-muted">{path || '/'}</span>
        </div>
        {error && (
          <p className="border-b border-border-subtle px-3 py-2 text-xs text-err" role="alert">
            {error}
          </p>
        )}
        <FileBrowser
          queryKey={['local']}
          fetchPath={(p) => `/api/browse/local?path=${encodeURIComponent(p)}`}
          path={path}
          onNavigate={setPath}
          emptyHint={t('browser.emptyLocal')}
          actions={(e) => actions(e)}
        />
      </section>
    </div>
  )
}
