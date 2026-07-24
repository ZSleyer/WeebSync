import { useState } from 'react'
import { LayoutGrid, List, Pencil, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type Entry } from '../api'
import { FileBrowser } from '../components/FileBrowser'
import { CatalogGrid } from './Remote'
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
  const [view, setView] = useState<'classic' | 'catalog'>('classic')
  const [path, setPath] = useState('')
  const [error, setError] = useState('')

  // both views read from their own cache: the plain listing and the catalog
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['local'] })
    qc.invalidateQueries({ queryKey: ['catalog', 0] })
  }

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

  // rename/delete buttons, shared by the classic list rows and the catalog
  // cards. Admins only; everyone else just reads.
  const actions = (e: Entry, className = '') =>
    user?.isAdmin ? (
      <span className={`my-1 mr-2 flex shrink-0 gap-1.5 ${className}`}>
        <button
          type="button"
          className="t-btn t-btn--sm"
          aria-label={t('local.renameItem', { name: e.name })}
          title={t('local.rename')}
          onClick={() => rename(e)}
        >
          <Pencil aria-hidden size="1.2em" />
        </button>
        <button
          type="button"
          className="t-btn t-btn--sm t-btn--danger"
          aria-label={t('local.deleteItem', { name: e.name })}
          title={t('local.delete')}
          onClick={() => remove(e)}
        >
          <X aria-hidden size="1.2em" />
        </button>
      </span>
    ) : undefined

  return (
    <div className="flex min-h-[calc(100dvh-8rem)] flex-col lg:h-[calc(100dvh-3rem)]">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="font-display text-xl font-semibold tracking-wider">{t('local.title')}</h2>
          <span className="t-label mt-1">{t('local.sub')}</span>
        </div>
        <div role="group" aria-label={t('remote.view')} className="flex">
          <button
            className={`t-btn t-btn--sm ${view === 'classic' ? 't-btn--primary' : ''}`}
            aria-pressed={view === 'classic'}
            onClick={() => setView('classic')}
          >
            <List aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('remote.classic')}
          </button>
          <button
            className={`t-btn t-btn--sm ${view === 'catalog' ? 't-btn--primary' : ''}`}
            aria-pressed={view === 'catalog'}
            onClick={() => setView('catalog')}
          >
            <LayoutGrid aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('remote.catalog')}
          </button>
        </div>
      </header>

      <section className="t-panel flex min-h-64 min-w-0 flex-col lg:min-h-0" aria-label={t('local.title')}>
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          <span className="t-label t-label--accent">{t('remote.local')}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-t-muted">{path || '/'}</span>
        </div>
        {error && (
          <p className="border-b border-border-subtle px-3 py-2 text-xs text-err" role="alert">
            {error}
          </p>
        )}
        {view === 'catalog' ? (
          // same catalog as the remote browser, addressed as source id 0 -
          // scopes, matches and the metadata cache are shared, so a folder
          // already matched on a server is not looked up twice
          <CatalogGrid
            serverId={0}
            path={path}
            onNavigate={setPath}
            onSelect={() => {}}
            cardActions={(e) => actions(e, 'my-0 mr-0')}
            onOpenFiles={(p) => {
              setPath(p.replace(/^\//, ''))
              setView('classic')
            }}
          />
        ) : (
        <FileBrowser
          queryKey={['local']}
          fetchPath={(p) => `/api/browse/local?path=${encodeURIComponent(p)}`}
          path={path}
          onNavigate={setPath}
          emptyHint={t('remote.emptyLocal')}
          actions={(e) => actions(e)}
        />
        )}
      </section>
    </div>
  )
}
