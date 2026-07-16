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
// Browser, edit from the Watches page). Anatomy: fixed header, scrollable
// body in three sections (paths / rename / live preview), sticky footer.
// The dry-run preview loads automatically (debounced) and follows the
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
  const backdropDown = useRef(false) // pointerdown started on the backdrop, not mid-drag from a field
  const [f, setF] = useState(initial)
  const [renameOn, setRenameOn] = useState(!!(initial.template || initial.pattern))
  const [browse, setBrowse] = useState<'remote' | 'local' | null>(null)
  // remote picker starts at the parent of the current watch folder
  const [browsePath, setBrowsePath] = useState(() =>
    initial.remotePath.split('/').filter(Boolean).slice(0, -1).join('/'),
  )
  const [pairs, setPairs] = useState<RenamePair[] | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const hasRule = (f.mode === 'template' && !!f.template) || (f.mode === 'regex' && !!f.pattern)

  // live preview, debounced against typing
  useEffect(() => {
    if (!renameOn || !hasRule || !f.remotePath) {
      setPairs(null)
      return
    }
    let stale = false // an in-flight preview must not overwrite a newer one
    const run = setTimeout(async () => {
      setPreviewBusy(true)
      try {
        const entries = await api.get<Entry[]>(
          `/api/servers/${serverId}/browse?path=${encodeURIComponent(f.remotePath)}`,
        )
        const names = entries.filter((e) => !e.isDir).map((e) => e.name).slice(0, 8)
        const next = names.length ? await api.post<RenamePair[]>('/api/rename/names', { names, ...f }) : []
        if (!stale) setPairs(next)
      } catch {
        if (!stale) setPairs(null) // preview is best-effort; saving reports real errors
      } finally {
        if (!stale) setPreviewBusy(false)
      }
    }, 500)
    return () => {
      stale = true
      clearTimeout(run)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameOn, hasRule, serverId, f.remotePath, f.mode, f.template, f.separator, f.titleOverride, f.pattern, f.replacement])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      // rename off = keep original names, persist empty rules
      await onSave(renameOn ? f : { ...f, template: '', pattern: '', replacement: '' })
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
      <div>
        <label className="mb-1 block w-fit text-xs text-t-muted" htmlFor={`watch-path-${which}`}>
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
          <div className="mt-2 flex max-h-56 flex-col overflow-hidden border border-border-subtle bg-bg-secondary/40">
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
    <dialog ref={ref} className="w-full max-w-2xl p-0" aria-label={title} onClose={onClose} onPointerDown={(e) => (backdropDown.current = e.target === ref.current)} onClick={(e) => e.target === ref.current && backdropDown.current && ref.current?.close()}>
      <form className="flex max-h-[85vh] flex-col" onSubmit={submit}>
        <header className="border-b border-border-subtle px-5 py-4">
          <h3 className="font-display font-semibold tracking-wider">{title}</h3>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section className="space-y-3" aria-label={t('watch.sectionPaths')}>
            <span className="t-label t-label--accent">{t('watch.sectionPaths')}</span>
            {pathRow('remote')}
            {pathRow('local')}
          </section>

          <section className="space-y-3 border-t border-border-subtle pt-4" aria-label={t('watch.sectionRename')}>
            <div className="flex items-center justify-between">
              <span className="t-label t-label--accent">{t('watch.sectionRename')}</span>
              <label className="flex items-center gap-2 text-sm text-t-secondary">
                <input type="checkbox" checked={renameOn} onChange={(e) => setRenameOn(e.target.checked)} />
                {t('watch.renameToggle')}
              </label>
            </div>

            {renameOn && (
              <>
                <div className="flex gap-1" role="group" aria-label={t('rename.mode')}>
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
                    <div>
                      <label className="mb-1 block w-fit text-xs text-t-muted" htmlFor="watch-template">
                        {t('watch.template')}
                      </label>
                      <input
                        id="watch-template"
                        className="t-input font-mono"
                        placeholder="{title} - S{season:02}E{episode:02}"
                        value={f.template}
                        onChange={(e) => setF({ ...f, template: e.target.value })}
                      />
                      <p className="mt-1 text-xs text-t-muted">{t('watch.templateHint')}</p>
                    </div>
                    <div className="flex flex-wrap gap-1">
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
                      <button
                        type="button"
                        className="t-btn t-btn--sm"
                        onClick={() =>
                          setF({ ...f, template: '{title} - S{season:02}E{episode:02} [{dub}][{resolution}]' })
                        }
                      >
                        {t('rename.presetTags')}
                      </button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
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
                  <div className="grid gap-3 sm:grid-cols-2">
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
              </>
            )}
          </section>

          {renameOn && hasRule && (
            <section className="space-y-2 border-t border-border-subtle pt-4" aria-label={t('rename.preview')}>
              <div className="flex items-center gap-2">
                <span className="t-label t-label--accent">{t('rename.preview')}</span>
                {previewBusy && (
                  <span className="text-xs text-t-muted" role="status">
                    {t('app.loading')}…
                  </span>
                )}
              </div>
              {pairs && (
                <div className="max-h-40 overflow-y-auto border border-border-subtle">
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
            </section>
          )}

          {error && (
            <p className="border border-err/40 px-3 py-2 text-sm text-err" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button type="button" className="t-btn" onClick={() => ref.current?.close()}>
            {t('servers.cancel')}
          </button>
          <button className="t-btn t-btn--primary t-cut" disabled={busy}>
            {t('settings.save')}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
