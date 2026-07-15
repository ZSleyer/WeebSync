import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type Entry, type RenamePair } from '../api'
import { FileBrowser, LocalPicker } from './FileBrowser'

export interface WatchFields {
  remotePath: string
  localPath: string
  mode: string // "template" | "regex"
  template: string
  separator: string
  titleOverride: string
  pattern: string
  replacement: string
}

// WatchDialog collects the paths and rename rule of a watch (create from
// Browser, edit from the Watches page). Both paths are correctable inline,
// by hand or via an embedded browser; the dry-run preview follows the
// current remote path.
export default function WatchDialog({
  title,
  serverId,
  initial,
  onSave,
  onClose,
}: {
  title: string
  serverId: number
  initial: WatchFields
  onSave: (f: WatchFields) => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDialogElement>(null)
  const [f, setF] = useState(initial)
  const [browse, setBrowse] = useState<'remote' | 'local' | null>(null)
  // remote picker starts at the parent of the current watch folder
  const [browsePath, setBrowsePath] = useState(() =>
    initial.remotePath.split('/').filter(Boolean).slice(0, -1).join('/'),
  )
  const [pairs, setPairs] = useState<RenamePair[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const noRename = (f.mode === 'template' && !f.template) || (f.mode === 'regex' && !f.pattern)

  const preview = async () => {
    setError('')
    try {
      const entries = await api.get<Entry[]>(
        `/api/servers/${serverId}/browse?path=${encodeURIComponent(f.remotePath)}`,
      )
      const names = entries.filter((e) => !e.isDir).map((e) => e.name).slice(0, 8)
      setPairs(names.length ? await api.post<RenamePair[]>('/api/rename/names', { names, ...f }) : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onSave(f)
      ref.current?.close()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }

  const pathRow = (which: 'remote' | 'local') => {
    const isRemote = which === 'remote'
    return (
      <div className="mb-3">
        <label className="t-label mb-1 block w-fit" htmlFor={`watch-path-${which}`}>
          {t(isRemote ? 'watch.remotePath' : 'watch.localPath')}
        </label>
        <div className="flex items-center gap-2">
          {!isRemote && <span className="shrink-0 font-mono text-xs text-t-muted">downloads/</span>}
          <input
            id={`watch-path-${which}`}
            className="t-input font-mono"
            value={isRemote ? f.remotePath : f.localPath}
            onChange={(e) => setF({ ...f, [isRemote ? 'remotePath' : 'localPath']: e.target.value })}
          />
          <button
            type="button"
            className={`t-btn t-btn--sm shrink-0 ${browse === which ? 't-btn--primary' : ''}`}
            aria-expanded={browse === which}
            onClick={() => setBrowse(browse === which ? null : which)}
          >
            {t('watch.browse')}
          </button>
        </div>
        {browse === which && (
          <div className="mt-2 flex max-h-56 flex-col overflow-hidden border border-border-subtle">
            {isRemote ? (
              <FileBrowser
                queryKey={['watch-remote', serverId]}
                fetchPath={(p) => `/api/servers/${serverId}/browse${p ? `?path=${encodeURIComponent('/' + p)}` : ''}`}
                path={browsePath}
                onNavigate={setBrowsePath}
                onSelect={(e) => {
                  setF({ ...f, remotePath: e.path })
                  setBrowse(null)
                }}
                selected={f.remotePath}
                selectDirsOnly
              />
            ) : (
              <LocalPicker path={f.localPath} onNavigate={(p) => setF({ ...f, localPath: p })} />
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <dialog ref={ref} className="w-full max-w-xl" aria-label={title} onClose={onClose}>
      <form className="p-5" onSubmit={submit}>
        <h3 className="mb-3 font-display font-semibold tracking-wider">{title}</h3>

        {pathRow('remote')}
        {pathRow('local')}

        <div className="mb-3 flex gap-1" role="group" aria-label={t('rename.mode')}>
          <button
            type="button"
            aria-pressed={f.mode === 'template'}
            className={`t-btn t-btn--sm ${f.mode === 'template' ? 't-btn--primary' : ''}`}
            onClick={() => setF({ ...f, mode: 'template' })}
          >
            {t('rename.template')}
          </button>
          <button
            type="button"
            aria-pressed={f.mode === 'regex'}
            className={`t-btn t-btn--sm ${f.mode === 'regex' ? 't-btn--primary' : ''}`}
            onClick={() => setF({ ...f, mode: 'regex' })}
          >
            {t('rename.regex')}
          </button>
        </div>

        {f.mode === 'template' ? (
          <>
            <label className="t-label mb-1 block w-fit" htmlFor="watch-template">
              {t('watch.template')}
            </label>
            <input
              id="watch-template"
              className="t-input mb-1 font-mono"
              placeholder="{title} - S{season:02}E{episode:02}"
              value={f.template}
              onChange={(e) => setF({ ...f, template: e.target.value })}
            />
            <p className="mb-2 text-xs text-t-muted">{t('watch.templateHint')}</p>
            <div className="mb-3 flex flex-wrap gap-1">
              <button
                type="button"
                className="t-btn t-btn--sm"
                onClick={() => setF({ ...f, template: '{title} - S{season:02}E{episode:02}' })}
              >
                {t('rename.presetPlex')}
              </button>
              <button
                type="button"
                className="t-btn t-btn--sm"
                onClick={() => setF({ ...f, template: '{title}.S{season:02}E{episode:02}', separator: '.' })}
              >
                {t('rename.presetCompact')}
              </button>
              <button type="button" className="t-btn t-btn--sm" onClick={() => setF({ ...f, template: '' })}>
                {t('watch.noRename')}
              </button>
            </div>
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-t-muted">
                {t('rename.separator')}
                <span className="t-select-wrap mt-1 block">
                  <select
                    className="t-select"
                    value={f.separator}
                    onChange={(e) => setF({ ...f, separator: e.target.value })}
                  >
                    <option value="">{t('rename.sepSpace')}</option>
                    <option value="_">{t('rename.sepUnderscore')}</option>
                    <option value=".">{t('rename.sepDot')}</option>
                    <option value="-">{t('rename.sepDash')}</option>
                  </select>
                </span>
              </label>
              <label className="text-xs text-t-muted">
                {t('rename.titleOverride')}
                <input
                  className="t-input mt-1"
                  placeholder={t('rename.titlePlaceholder')}
                  value={f.titleOverride}
                  onChange={(e) => setF({ ...f, titleOverride: e.target.value })}
                />
              </label>
            </div>
          </>
        ) : (
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-t-muted">
              {t('rename.pattern')}
              <input
                className="t-input mt-1 font-mono"
                value={f.pattern}
                onChange={(e) => setF({ ...f, pattern: e.target.value })}
              />
            </label>
            <label className="text-xs text-t-muted">
              {t('rename.replacement')}
              <input
                className="t-input mt-1 font-mono"
                value={f.replacement}
                onChange={(e) => setF({ ...f, replacement: e.target.value })}
              />
            </label>
          </div>
        )}

        <button type="button" className="t-btn t-btn--sm" disabled={noRename} onClick={preview}>
          {t('rename.preview')}
        </button>
        {pairs && (
          <div className="mt-2 max-h-40 overflow-y-auto border border-border-subtle">
            {pairs.length === 0 && <p className="p-2 text-xs text-t-muted">{t('browser.emptyDir')}</p>}
            {pairs.map((p) => (
              <p key={p.old} className="border-b border-border-subtle/50 px-2 py-1 font-mono text-[11px]">
                <span className="text-t-muted">{p.old}</span>
                <span className="text-t-faint"> → </span>
                <span className={p.error ? 'text-err' : 'text-accent'}>{p.error ?? p.new}</span>
              </p>
            ))}
          </div>
        )}

        {error && (
          <p className="mt-3 border border-err/40 px-3 py-2 text-sm text-err" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="t-btn" onClick={() => ref.current?.close()}>
            {t('servers.cancel')}
          </button>
          <button className="t-btn t-btn--primary t-cut" disabled={busy}>
            {t('settings.save')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
