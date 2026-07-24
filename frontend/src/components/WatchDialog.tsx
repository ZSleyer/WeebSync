import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import { useConfirm } from './confirm'
import { FileBrowser, LocalPicker } from './FileBrowser'
import Loading from './Loading'
import RenameOptions, { Hint, type RenameProfile, type RenameRule } from './RenameOptions'
import { useRenamePreview } from './useRenamePreview'

export interface WatchFields extends RenameRule {
  remotePath: string
  localPath: string
  subfolder: boolean
  mediaId: number
  mediaSource: string
  wantDub: string
  wantSub: string
  plexAudioLang: string
  plexSubLang: string
}

// WatchDialog collects the paths and rename rule of a watch (create from
// Browser, edit from the Watches page). Anatomy: fixed header, scrollable
// body in five sections (source&target / display metadata / download filter /
// Plex playback / rename+preview), sticky footer. The dry-run preview loads
// automatically.
export default function WatchDialog({
  title,
  serverId,
  initial,
  onSave,
  onClose,
  saveLabel,
  info,
}: {
  title: string
  serverId: number
  initial: WatchFields
  onSave: (f: WatchFields) => Promise<void>
  onClose: () => void
  saveLabel?: string // footer button text; defaults to the watch "save" label
  info?: string[] // context lines under the header (e.g. chosen upgrade source vs local quality)
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const ref = useRef<HTMLDialogElement>(null)
  const backdropDown = useRef(false) // pointerdown started on the backdrop, not mid-drag from a field
  const [f, setF] = useState(initial)
  // TVDB is only offered as a source when a key is set (settings is admin-only;
  // a 403 just leaves the option hidden)
  const { data: caps } = useQuery<{ tvdbApiKeySet?: boolean; tmdbApiKeySet?: boolean }>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
    retry: false,
    staleTime: 5 * 60_000,
  })
  // the rename profile + resolved series match Plex/the provider report
  const { data: detected } = useQuery<RenameProfile>({
    queryKey: ['rename-profile', serverId, f.remotePath, f.localPath, f.renameProvider],
    queryFn: () =>
      api.get(
        `/api/servers/${serverId}/rename-profile?path=${encodeURIComponent(f.remotePath)}&local=${encodeURIComponent(f.localPath)}&provider=${f.renameProvider}`,
      ),
    enabled: !!f.airedMapping && !!f.remotePath,
    retry: false,
    staleTime: 60_000,
  })
  const [renameOn, setRenameOn] = useState(!!(initial.template || initial.pattern))
  const [browse, setBrowse] = useState<'remote' | 'local' | null>(null)
  // remote picker starts at the parent of the current watch folder
  const [browsePath, setBrowsePath] = useState(() =>
    initial.remotePath.split('/').filter(Boolean).slice(0, -1).join('/'),
  )
  const [localBrowse, setLocalBrowse] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // language codes present in this server's index, for the dub/sub filter
  const [langs, setLangs] = useState<{ dub: string[]; sub: string[] }>({ dub: [], sub: [] })
  useEffect(() => {
    ref.current?.showModal()
    api
      .get<{ dub: string[]; sub: string[] }>(`/api/servers/${serverId}/languages`)
      .then(setLangs)
      .catch(() => {}) // filter is optional; a saved value still shows via its own option below
  }, [serverId])

  const { pairs, busy: previewBusy, hasRule } = useRenamePreview({ serverId, fields: f, enabled: renameOn })

  // unsaved-changes guard: confirm before closing via backdrop / Escape / cancel
  const dirty =
    JSON.stringify(f) !== JSON.stringify(initial) || renameOn !== !!(initial.template || initial.pattern)
  const guardedClose = async () => {
    if (
      dirty &&
      !(await confirm({
        title: t('common.unsavedTitle'),
        message: t('common.unsavedMsg'),
        confirmLabel: t('common.discard'),
        cancelLabel: t('common.keepEditing'),
        destructive: true,
      }))
    )
      return
    ref.current?.close()
  }
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

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
              <LocalPicker
                path={localBrowse}
                onNavigate={(p) => {
                  setLocalBrowse(p)
                  setF({ ...f, localPath: p })
                }}
              />
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <dialog ref={ref} className="w-full max-w-2xl p-0" aria-label={title} onClose={onClose} onCancel={(e) => { e.preventDefault(); guardedClose() }} onPointerDown={(e) => (backdropDown.current = e.target === ref.current)} onClick={(e) => e.target === ref.current && backdropDown.current && guardedClose()}>
      <form className="flex max-h-[85vh] flex-col" onSubmit={submit}>
        <header className="border-b border-border-subtle px-5 py-4">
          <h3 className="font-display font-semibold tracking-wider">{title}</h3>
          {info?.map((line, i) => (
            <p key={i} className="mt-1 text-[11px] text-t-secondary">
              {line}
            </p>
          ))}
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section className="space-y-3" aria-label={t('watch.sectionPaths')}>
            <span className="t-label t-label--accent">{t('watch.sectionPaths')}</span>
            {pathRow('remote')}
            {pathRow('local')}
            <label className="flex items-center gap-2 text-sm text-t-secondary">
              <input type="checkbox" checked={f.subfolder} onChange={(e) => setF({ ...f, subfolder: e.target.checked })} />
              {t('watch.subfolder')}
            </label>
          </section>

          <section className="space-y-3 border-t border-border-subtle pt-4" aria-label={t('watch.sectionMeta')}>
            <span className="t-label t-label--accent">{t('watch.sectionMeta')}</span>
            <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
              <label className="text-xs text-t-muted">
                {t('watch.mediaSource')}
                <Hint text={t('watch.metaHint')} />
                <span className="t-select-wrap mt-1 block">
                  <select
                    className="t-select"
                    value={f.mediaSource || 'anilist'}
                    onChange={(e) => setF({ ...f, mediaSource: e.target.value })}
                  >
                    <option value="anilist">AniList (Anime)</option>
                    <option value="tmdb:tv">TMDB Serie</option>
                    <option value="tmdb:movie">TMDB Film</option>
                    {(caps?.tvdbApiKeySet || f.mediaSource === 'tvdb') && <option value="tvdb">TVDB Serie</option>}
                  </select>
                </span>
              </label>
              <label className="text-xs text-t-muted" htmlFor="watch-mediaid">
                {t('watch.mediaId')}
                <input
                  id="watch-mediaid"
                  type="number"
                  className="t-input mt-1 font-mono"
                  value={f.mediaId || ''}
                  placeholder={
                    f.mediaSource === 'tvdb'
                      ? 'z.B. 72454 (Detektiv Conan)'
                      : f.mediaSource?.startsWith('tmdb')
                        ? 'z.B. 1399 (Game of Thrones)'
                        : 'z.B. 21 (One Piece)'
                  }
                  onChange={(e) => setF({ ...f, mediaId: Number(e.target.value) || 0 })}
                />
              </label>
            </div>
          </section>

          <section className="space-y-3 border-t border-border-subtle pt-4" aria-label={t('watch.sectionFilter')}>
            <span className="t-label t-label--accent">{t('watch.sectionFilter')}</span>
            <div className="grid gap-3 sm:grid-cols-2">
              {(['wantDub', 'wantSub'] as const).map((key) => {
                const opts = key === 'wantDub' ? langs.dub : langs.sub
                // include the saved value even if the index no longer lists it
                const all = f[key] && !opts.includes(f[key]) ? [f[key], ...opts] : opts
                return (
                  <label key={key} className="text-xs text-t-muted">
                    {t(key === 'wantDub' ? 'watch.wantDub' : 'watch.wantSub')}
                    {key === 'wantDub' && <Hint text={t('watch.langHint')} />}
                    <span className="t-select-wrap mt-1 block">
                      <select
                        className="t-select"
                        value={f[key]}
                        onChange={(e) => setF({ ...f, [key]: e.target.value })}
                      >
                        <option value="">{t('watch.langAny')}</option>
                        {all.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                )
              })}
            </div>
          </section>

          <section className="space-y-3 border-t border-border-subtle pt-4" aria-label={t('watch.sectionPlex')}>
            <span className="t-label t-label--accent">{t('watch.sectionPlex')}</span>
            <div className="grid gap-3 sm:grid-cols-2">
              {(['plexAudioLang', 'plexSubLang'] as const).map((key) => {
                const opts = key === 'plexAudioLang' ? langs.dub : langs.sub
                const all = f[key] && !opts.includes(f[key]) ? [f[key], ...opts] : opts
                return (
                  <label key={key} className="text-xs text-t-muted">
                    {t(key === 'plexAudioLang' ? 'watch.plexAudio' : 'watch.plexSub')}
                    {key === 'plexAudioLang' && <Hint text={t('watch.plexHint')} />}
                    <span className="t-select-wrap mt-1 block">
                      <select
                        className="t-select"
                        value={f[key]}
                        onChange={(e) => setF({ ...f, [key]: e.target.value })}
                      >
                        <option value="">{t('watch.plexNoChange')}</option>
                        {all.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                )
              })}
            </div>
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
                <RenameOptions
                  rule={f}
                  onChange={(patch) => setF({ ...f, ...patch })}
                  caps={caps}
                  detected={detected}
                  idPrefix="watch"
                  seriesQuery={f.remotePath.split('/').filter(Boolean).slice(-1)[0] || ''}
                  seasonFolder={{
                    name: f.localPath.split('/').filter(Boolean).pop() || '',
                    onUseParent: () =>
                      setF({ ...f, localPath: f.localPath.split('/').filter(Boolean).slice(0, -1).join('/') }),
                  }}
                />
              </>
            )}
          </section>

          {renameOn && hasRule && (
            <section className="space-y-2 border-t border-border-subtle pt-4" aria-label={t('rename.preview')}>
              <div className="flex items-center gap-2">
                <span className="t-label t-label--accent">{t('rename.preview')}</span>
                {previewBusy && <Loading />}
              </div>
              {pairs && (
                <div className="max-h-40 overflow-y-auto border border-border-subtle">
                  {pairs.length === 0 && <p className="p-2 text-xs text-t-muted">{t('remote.emptyDir')}</p>}
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
          <button type="button" className="t-btn" onClick={guardedClose}>
            {t('servers.cancel')}
          </button>
          <button className="t-btn t-btn--primary t-cut" disabled={busy}>
            {saveLabel ?? t('settings.save')}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
