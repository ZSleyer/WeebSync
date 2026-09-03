import { Folder, Save, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Dialog, Field, Input, Select } from '@weebsync/design-system'
import { api, ApiError, plexStreamLabel, plexStreamOptions } from '../api'
import { useConfirm } from './confirm'
import { FileBrowser, LocalPicker } from './FileBrowser'
import { FsErrorNote, isFsErrorCode } from './FsErrorNote'
import PathInput from './PathInput'
import PlexShowDialog, { usePlexShow } from './PlexShowDialog'
import RenameOptions, { Hint, ROW_GRID, type RenameProfile, type RenameRule } from './RenameOptions'
import RenamePreview from './RenamePreview'
import { useRenamePreview } from './useRenamePreview'
import { syncTargetDir, useTargetFolder } from './useTargetFolder'

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
  // one-off upgrade sync only: move the copy being improved on to the trash
  // once the new file is in place. Undefined hides the option.
  replaceOld?: boolean
}

// WatchDialog collects the paths and rename rule of a watch (create from
// Browser, edit from the Watches page). Anatomy: fixed header, scrollable
// body in five sections (source&target / display metadata / download filter /
// Plex playback / rename+preview), sticky footer. The dry-run preview loads
// automatically.
export default function WatchDialog({
  title,
  serverId,
  watchId,
  initial,
  onSave,
  onClose,
  saveLabel,
  info,
}: {
  title: string
  serverId: number
  /** id of the watch being edited; absent while creating one, which is when
   *  the Plex show binding has no series to hang on yet */
  watchId?: number
  initial: WatchFields
  /** returning a string keeps the dialog open and shows it: a sync that
   *  queued nothing has something to explain, and closing would hide it */
  onSave: (f: WatchFields) => Promise<void | string>
  onClose: () => void
  saveLabel?: string // footer button text; defaults to the watch "save" label
  info?: string[] // context lines under the header (e.g. chosen upgrade source vs local quality)
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
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
  // which Plex show the track selection acts on, and the picker that overrides it
  const { data: plexShow, refetch: refetchPlexShow } = usePlexShow(watchId)
  const [pickShow, setPickShow] = useState(false)
  const [renameOn, setRenameOn] = useState(!!(initial.template || initial.pattern))
  const [browse, setBrowse] = useState<'remote' | 'local' | null>(null)
  // remote picker starts at the parent of the current watch folder
  const [browsePath, setBrowsePath] = useState(() =>
    initial.remotePath.split('/').filter(Boolean).slice(0, -1).join('/'),
  )
  const [localBrowse, setLocalBrowse] = useState('')
  const [error, setError] = useState('')
  // a save refused because the target cannot be written: explained in full
  // rather than as a Go error string, same as on the dashboard
  const [fsError, setFsError] = useState<{ code: string; dir: string } | null>(null)
  // a neutral outcome worth reporting, e.g. "already there" - not an error
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  // language codes present in this server's index, for the dub/sub filter
  const [langs, setLangs] = useState<{ dub: string[]; sub: string[] }>({ dub: [], sub: [] })
  useEffect(() => {
    api
      .get<{ dub: string[]; sub: string[] }>(`/api/servers/${serverId}/languages`)
      .then(setLangs)
      .catch(() => {}) // filter is optional; a saved value still shows via its own option below
  }, [serverId])

  // the preview runs regardless of the rename switch: it is also where the
  // target comparison is shown, and that matters most when nothing is renamed
  const { pairs, sizes, busy: previewBusy } = useRenamePreview({ serverId, fields: f, enabled: true })

  // the folder the files really land in, and whether it is there yet
  const targetDir = syncTargetDir(f.localPath, f.remotePath, f.subfolder)
  const { entries: targetEntries, missing: targetMissing } = useTargetFolder(targetDir)

  // unsaved-changes guard: confirm before closing via backdrop / Escape / cancel
  const dirty =
    JSON.stringify(f) !== JSON.stringify(initial) || renameOn !== !!(initial.template || initial.pattern)
  // Dialog asks this before Escape or a backdrop click closes it
  const mayClose = async () => {
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
      return false
    return true
  }
  const cancel = async () => {
    if (await mayClose()) onClose()
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
    setFsError(null)
    try {
      // rename off = keep original names, persist empty rules
      const note = await onSave(renameOn ? f : { ...f, template: '', pattern: '', replacement: '' })
      if (note) {
        // nothing happened and there is a reason - say it here rather than
        // behind a closing dialog, where the user would never scroll to it
        setNotice(note)
        return
      }
      onClose()
    } catch (err) {
      // the backend classifies an unwritable target; anything else keeps the
      // plain message, because there is nothing more to say about it
      const body = err instanceof ApiError ? (err.data as { errorCode?: string; path?: string } | undefined) : undefined
      if (isFsErrorCode(body?.errorCode)) {
        setFsError({ code: body!.errorCode!, dir: body?.path ?? '' })
      } else {
        setError(err instanceof Error ? err.message : t('app.error'))
      }
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
        {/* stretch, not center: the button is t-btn--sm and would otherwise
            sit shorter than the path field next to it */}
        <div className="flex items-stretch gap-2">
          <PathInput
            id={`watch-path-${which}`}
            value={isRemote ? f.remotePath : f.localPath}
            onChange={(v) => setF({ ...f, [isRemote ? 'remotePath' : 'localPath']: v })}
            onCommit={(v) => setF({ ...f, [isRemote ? 'remotePath' : 'localPath']: v })}
            fetchPath={(p) =>
              isRemote
                ? `/api/servers/${serverId}/browse${p ? `?path=${encodeURIComponent('/' + p.replace(/^\/+/, ''))}` : ''}`
                : `/api/browse/local?path=${encodeURIComponent(p.replace(/^\/+/, ''))}`
            }
            queryKey={isRemote ? ['watch-remote', serverId] : ['local']}
            ariaLabel={t(isRemote ? 'watch.remotePath' : 'watch.localPath')}
          />
          <Button
            size="sm"
            className="shrink-0"
            variant={browse === which ? 'primary' : 'default'}
            aria-expanded={browse === which}
            onClick={() => setBrowse(browse === which ? null : which)}
          >
            <Folder aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('watch.browse')}
          </Button>
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
    <Dialog onClose={onClose} onRequestClose={mayClose} width="max-w-2xl" aria-label={title}>
      <form className="dialog-body" onSubmit={submit}>
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
            <Badge tone="accent">{t('watch.sectionPaths')}</Badge>
            {pathRow('remote')}
            {pathRow('local')}
            <label className="flex items-center gap-2 text-sm text-t-secondary">
              <input type="checkbox" checked={f.subfolder} onChange={(e) => setF({ ...f, subfolder: e.target.checked })} />
              {t('watch.subfolder')}
            </label>
            {f.replaceOld !== undefined && (
              <label className="flex items-center gap-2 text-sm text-t-secondary">
                <input type="checkbox" checked={f.replaceOld} onChange={(e) => setF({ ...f, replaceOld: e.target.checked })} />
                {t('watch.replaceOld')}
                <Hint text={t('watch.replaceOldHint')} />
              </label>
            )}
            {/* no folder name: several levels can be missing at once, and
                naming only the innermost reads as if the rest were there */}
            {targetMissing && <p className="text-[11px] text-t-muted">{t('watch.targetMissing')}</p>}
          </section>

          <section className="space-y-3 border-t border-border-subtle pt-4" aria-label={t('watch.sectionMeta')}>
            <Badge tone="accent">{t('watch.sectionMeta')}</Badge>
            {/* same 50/50 split as every other two-column row in this dialog,
                so the column edge never shifts between sections */}
            <div className={ROW_GRID}>
              <Field
                label={
                  <>
                    {t('watch.mediaSource')}
                    <Hint text={t('watch.metaHint')} />
                  </>
                }
              >
                <Select
                  value={f.mediaSource || 'anilist'}
                  onChange={(e) => setF({ ...f, mediaSource: e.target.value })}
                >
                  <option value="anilist">AniList (Anime)</option>
                  <option value="tmdb:tv">TMDB Serie</option>
                  <option value="tmdb:movie">TMDB Film</option>
                  {(caps?.tvdbApiKeySet || f.mediaSource === 'tvdb') && <option value="tvdb">TVDB Serie</option>}
                </Select>
              </Field>
              <Field label={t('watch.mediaId')} htmlFor="watch-mediaid">
                <Input
                  id="watch-mediaid"
                  type="number"
                  className="font-mono"
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
              </Field>
            </div>
          </section>

          <section className="space-y-3 border-t border-border-subtle pt-4" aria-label={t('watch.sectionFilter')}>
            <Badge tone="accent">{t('watch.sectionFilter')}</Badge>
            <div className={ROW_GRID}>
              {(['wantDub', 'wantSub'] as const).map((key) => {
                const opts = key === 'wantDub' ? langs.dub : langs.sub
                // include the saved value even if the index no longer lists it
                const all = f[key] && !opts.includes(f[key]) ? [f[key], ...opts] : opts
                return (
                  <Field
                    key={key}
                    label={
                      <>
                        {t(key === 'wantDub' ? 'watch.wantDub' : 'watch.wantSub')}
                        {key === 'wantDub' && <Hint text={t('watch.langHint')} />}
                      </>
                    }
                  >
                    <Select value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })}>
                      <option value="">{t('watch.langAny')}</option>
                      {all.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )
              })}
            </div>
          </section>

          <section className="space-y-3 border-t border-border-subtle pt-4" aria-label={t('watch.sectionPlex')}>
            <Badge tone="accent">{t('watch.sectionPlex')}</Badge>
            {/* which show the track selection acts on. Only on an existing
                watch: the binding hangs on its series, which a watch that is
                not saved yet does not have. */}
            {watchId && plexShow && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-t-secondary">
                <span>
                  {t('watch.plexShow')}:{' '}
                  <span className="text-t-primary">{plexShow.show?.title || t('watch.plexShowUnresolved')}</span>
                </span>
                <span className="text-xs text-t-muted">{t(`watch.plexShowSource.${plexShow.source}`)}</span>
                <Button size="sm" onClick={() => setPickShow(true)}>
                  {t('watch.plexShowChange')}
                </Button>
              </p>
            )}
            <div className={ROW_GRID}>
              {(['plexAudioLang', 'plexSubLang'] as const).map((key) => {
                // Subtitles carry a second dimension the language cannot express:
                // the forced track holds signs and foreign dialogue only. Both
                // variants are offered per language and neither is derived from
                // the audio - watching a dub with full subtitles and watching the
                // original with signs only are both things people do on purpose.
                const opts = plexStreamOptions(key === 'plexAudioLang' ? langs.dub : langs.sub, key === 'plexSubLang')
                const all = f[key] && !opts.includes(f[key]) ? [f[key], ...opts] : opts
                return (
                  <Field
                    key={key}
                    label={
                      <>
                        {t(key === 'plexAudioLang' ? 'watch.plexAudio' : 'watch.plexSub')}
                        {key === 'plexAudioLang' && <Hint text={t('watch.plexHint')} />}
                      </>
                    }
                  >
                    <Select value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })}>
                      <option value="">{t('watch.plexNoChange')}</option>
                      {key === 'plexSubLang' && <option value="off">{t('watch.plexSubOff')}</option>}
                      {all.map((c) => (
                        <option key={c} value={c}>
                          {plexStreamLabel(c, t)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )
              })}
            </div>
          </section>

          <section className="space-y-3 border-t border-border-subtle pt-4" aria-label={t('watch.sectionRename')}>
            <div className="flex items-center justify-between">
              <Badge tone="accent">{t('watch.sectionRename')}</Badge>
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

          {pairs && <RenamePreview pairs={pairs} sizes={sizes} target={targetEntries} busy={previewBusy} />}

          {fsError && <FsErrorNote code={fsError.code} dir={fsError.dir} />}
          {error && (
            <p className="border border-err/40 px-3 py-2 text-sm text-err" role="alert">
              {error}
            </p>
          )}
        </div>

        {/* the outcome belongs next to the button that caused it: in the
            scrollable body it would sit below the fold, which is exactly how
            the old notice above the page managed to stay unread */}
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
          {notice && (
            <p className="mr-auto min-w-0 flex-1 text-[11px] text-warn" role="status">
              {notice}
            </p>
          )}
          <Button onClick={cancel}>
            <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('servers.cancel')}
          </Button>
          <Button type="submit" variant="primary" cut disabled={busy}>
            <Save aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {saveLabel ?? t('settings.save')}
          </Button>
        </footer>
      </form>
      {pickShow && watchId && plexShow && (
        <PlexShowDialog
          watchId={watchId}
          state={plexShow}
          onDone={refetchPlexShow}
          onClose={() => setPickShow(false)}
        />
      )}
    </Dialog>
  )
}
