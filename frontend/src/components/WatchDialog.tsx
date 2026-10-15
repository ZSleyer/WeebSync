import { Folder, Save, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth, useMediaServer, useProviders } from '../hooks'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Field, Input, Select } from 'fluid-lycoris'
import {
  api,
  ApiError,
  plexStreamLabel,
  plexStreamOptions,
  providerName,
  type CatalogExplain,
  type Entry,
  type SubfolderMode,
} from '../api'
import { RematchDialog } from './Rematch'
import { useConfirm } from './confirm'
import { FileBrowser, LocalPicker } from './FileBrowser'
import { FsErrorNote, isFsErrorCode } from './FsErrorNote'
import PathInput from './PathInput'
import PlexShowField, { usePlexShow } from './PlexShowField'
import RenameOptions, { FromEpisodeField, Hint, ROW_GRID, type RenameProfile, type RenameRule } from './RenameOptions'
import RenamePreview from './RenamePreview'
import { useRenamePreview } from './useRenamePreview'
import SubfolderChoice from './SubfolderChoice'
import {
  seasonInPath,
  subfolderMode,
  subfolderTargetDir,
  syncRequestPath,
  syncTargetDir,
  useTargetFolder,
} from './useTargetFolder'
import { useFolderKind } from './watchDefaults'
import './watchForm.css'

export interface WatchFields extends RenameRule {
  remotePath: string
  localPath: string
  subfolder: boolean
  // The three-way subfolder choice, as it comes from the user's defaults. It
  // is dialog state only: "title" is resolved into localPath on save, so a
  // watch never carries it (see SubfolderChoice).
  subfolderSource?: SubfolderMode
  subfolderSeparator?: string
  // the season folder a title subfolder gets under it; dialog state as well
  seasonFolder?: string
  mediaId: number
  mediaSource: string
  wantDub: string
  wantSub: string
  // days the dub's release trails the original, for the calendar's dub slots
  // before a release has shown the real lag; 0 = wait for one
  dubLagDays?: number
  plexAudioLang: string
  plexSubLang: string
  // one-off upgrade sync only: move the copy being improved on to the trash
  // once the new file is in place. Undefined hides the option.
  replaceOld?: boolean
  // editing only: the files in the old target folder move to the new one
  moveFiles?: boolean
}

export interface WatchFormProps {
  title: string
  serverId: number
  /** id of the watch being edited; absent while creating one, which is when
   *  the Plex show binding has no series to hang on yet */
  watchId?: number
  initial: WatchFields
  /** returning a string keeps the form open and shows it: a sync that
   *  queued nothing has something to explain, and closing would hide it */
  onSave: (f: WatchFields) => Promise<void | string>
  /** leaves the form: after a save, or a cancel the guard let through */
  onClose: () => void
  saveLabel?: string // footer button text; defaults to the watch "save" label
  info?: string[] // context lines under the header (e.g. chosen upgrade source vs local quality)
}

// WatchDialog collects the paths and rename rule of a watch (create from
// Browser, edit from the Watches page). Anatomy: fixed header, scrollable
// body in five sections (source&target / display metadata / download filter /
// Plex playback / rename+preview), sticky footer. The dry-run preview loads
// automatically.

export default function WatchDialog(props: WatchFormProps) {
  const guard = useRef<() => Promise<boolean>>(async () => true)
  return (
    <Dialog onClose={props.onClose} onRequestClose={() => guard.current()} width="max-w-2xl" aria-label={props.title}>
      <WatchForm {...props} onGuard={(check) => (guard.current = check)} />
    </Dialog>
  )
}

/**
 * The watch editor without a dialog of its own: the title card swaps it in
 * where its content was, so editing from there is not a second modal. The
 * container asks the check it gets from `onGuard` before it lets the form go
 * any other way than its own buttons (Escape, the backdrop, a back arrow).
 */
export function WatchForm({
  title,
  serverId,
  watchId,
  initial,
  onSave,
  onClose,
  saveLabel,
  info,
  onGuard,
  inPage,
  className,
}: WatchFormProps & {
  /** receives the unsaved-changes check, for the container to ask */
  onGuard: (check: () => Promise<boolean>) => void
  /** shown in the series page, whose bar carries the title and the way back */
  inPage?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [f, setF] = useState(initial)
  // replacing old copies, moving a folder's contents and Plex track choices
  // act on the shared library or the admin's Plex: an admin's (the server
  // refuses or drops them for anyone else)
  const { data: me } = useAuth()
  const isAdmin = !!me?.isAdmin
  // only Plex keeps a per-episode track choice; Jellyfin picks at play time
  const tracks = useMediaServer() !== 'jellyfin'
  // TVDB is only offered as a source when a key is set
  const caps = useProviders()
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
  // which Plex show the track selection acts on; the field below overrides it
  const { data: plexShow, refetch: refetchPlexShow } = usePlexShow(watchId)
  const [renameOn, setRenameOn] = useState(!!(initial.template || initial.pattern))
  const initialSub = subfolderMode(initial)
  const [subMode, setSubMode] = useState<SubfolderMode>(initialSub)
  const [subSep, setSubSep] = useState(initial.subfolderSeparator ?? '')
  // the title a "by title" subfolder is named after: the rename override wins,
  // exactly as it does over the provider title in the file names
  const { data: folder, isPending: folderPending } = useFolderKind(serverId, f.remotePath)
  // books: matched as manga, or found to hold volumes and no video
  const manga = f.mediaSource === 'anilist:manga' || folder?.kind === 'manga'
  // correcting the match: the source to search comes from the server, which
  // knows the mark and the library the folder answers to
  const qc = useQueryClient()
  const [matching, setMatching] = useState(false)
  const { data: explained, isError: unexplained } = useQuery({
    queryKey: ['catalog-explain', serverId, initial.remotePath],
    queryFn: () =>
      api.get<CatalogExplain>(
        `/api/servers/${serverId}/catalog/explain?folder=${encodeURIComponent(initial.remotePath)}`,
      ),
    enabled: matching,
    staleTime: 60_000,
    retry: false,
  })
  const seriesTitle = f.titleOverride || folder?.title || ''
  // undefined while the lookup runs: "no title found" is a claim worth making
  // only once the answer is in, otherwise every open flashes the fallback note
  const shownTitle = f.titleOverride || !folderPending ? seriesTitle : undefined
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

  // the season's folder under a title folder - unless the template lays the
  // folders out itself, then the season is its business
  const seasonFolder = seasonInPath(f.template, f.airedMapping) ? (f.seasonFolder ?? folder?.seasonFolder ?? '') : ''
  // the folder the files really land in, and whether it is there yet
  const targetDir = subfolderTargetDir(f.localPath, f.remotePath, subMode, seriesTitle, subSep, seasonFolder)
  const { entries: targetEntries, missing: targetMissing } = useTargetFolder(targetDir)
  // a watch moved to another folder: its files can come along. The folders as
  // the backend sees them (the stored path, plus the remote folder's name with
  // a subfolder), so this asks exactly when the server would move something
  const oldFolder = initial.localPath ? syncTargetDir(initial.localPath, initial.remotePath, initial.subfolder) : ''
  const newFolder = syncTargetDir(syncRequestPath(subMode, f.localPath, targetDir), f.remotePath, subMode === 'remote')
  const targetMoved = watchId !== undefined && oldFolder !== '' && oldFolder !== newFolder
  const [moveFiles, setMoveFiles] = useState(true)

  // the preview runs regardless of the rename switch: it is also where the
  // target comparison is shown, and that matters most when nothing is renamed.
  // It reads the folder the sync will really use, not the base path.
  const {
    pairs,
    sizes,
    busy: previewBusy,
  } = useRenamePreview({
    serverId,
    fields: { ...f, localPath: targetDir },
    enabled: true,
  })

  // unsaved-changes guard: confirm before closing via backdrop / Escape / cancel
  const dirty =
    JSON.stringify(f) !== JSON.stringify(initial) ||
    renameOn !== !!(initial.template || initial.pattern) ||
    subMode !== initialSub ||
    subSep !== (initial.subfolderSeparator ?? '')
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
  // braces: an arrow that returned onGuard's result would hand React the
  // check as cleanup, and a re-render or the unmount after a save would ask it
  useEffect(() => {
    onGuard(mayClose)
  })
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
      // the title folder is resolved here, once: what the watch stores is the
      // finished path, so a later title change cannot strand it elsewhere.
      // The other two modes keep the payload the backend has always seen.
      const { subfolderSource: _src, subfolderSeparator: _sep, seasonFolder: _season, ...rest } = f
      const saved: WatchFields = {
        ...rest,
        localPath: syncRequestPath(subMode, f.localPath, targetDir),
        subfolder: subMode === 'remote',
        ...(targetMoved && isAdmin ? { moveFiles } : {}),
        // an edit never writes the match: it is the catalogue's, corrected
        // through the button above, and the id the form opened with would
        // undo a correction made since
        ...(watchId ? { mediaId: 0 } : {}),
      }
      // rename off = keep original names, persist empty rules
      const note = await onSave(renameOn ? saved : { ...saved, template: '', pattern: '', replacement: '' })
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
          <div className="mt-2 flex max-h-56 flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-secondary/40">
            {isRemote ? (
              <FileBrowser
                queryKey={['watch-remote', serverId]}
                serverId={serverId}
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
    <form className={`dialog-body ${className ?? ''}`} onSubmit={submit}>
      {inPage ? (
        // the page's bar names the form; only the context lines stay
        info?.length ? (
          <div className="border-b border-border-subtle px-5 py-3">
            {info.map((line, i) => (
              <p key={i} className="text-ctl-sm text-t-secondary">
                {line}
              </p>
            ))}
          </div>
        ) : null
      ) : (
        <header className="border-b border-border-subtle px-5 py-4">
          <h2 className="ws-form-title">{title}</h2>
          {info?.map((line, i) => (
            <p key={i} className="mt-1 text-ctl-sm text-t-secondary">
              {line}
            </p>
          ))}
        </header>
      )}

      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-5 py-4">
        <section className="ws-form-sec space-y-3" aria-label={t('watch.sectionPaths')}>
          <h3 className="ws-form-h">{t('watch.sectionPaths')}</h3>
          {pathRow('remote')}
          {pathRow('local')}
          <SubfolderChoice
            value={subMode}
            onChange={setSubMode}
            separator={subSep}
            onSeparator={setSubSep}
            title={shownTitle}
            seasonFolder={seasonFolder}
          />
          {isAdmin && f.replaceOld !== undefined && (
            <label className="flex items-center gap-2 text-sm text-t-secondary">
              <input
                type="checkbox"
                checked={f.replaceOld}
                onChange={(e) => setF({ ...f, replaceOld: e.target.checked })}
              />
              {t('watch.replaceOld')}
              <Hint text={t('watch.replaceOldHint')} />
            </label>
          )}
          {/* no folder name: several levels can be missing at once, and
                naming only the innermost reads as if the rest were there */}
          {targetMissing && <p className="text-ctl-sm text-t-muted">{t('watch.targetMissing')}</p>}
          {targetMoved && isAdmin && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={moveFiles}
                onChange={(e) => setMoveFiles(e.target.checked)}
              />
              <span>
                {t('watch.moveFiles')}
                <span className="block font-mono text-ctl-sm break-all text-t-muted">
                  {oldFolder} → {newFolder}
                </span>
              </span>
            </label>
          )}
        </section>

        <section className="ws-form-sec space-y-3" aria-label={t('watch.sectionMeta')}>
          <h3 className="ws-form-h">{t('watch.sectionMeta')}</h3>
          {/* same 50/50 split as every other two-column row in this dialog,
                so the column edge never shifts between sections */}
          {/* the match is the catalogue's: one place to correct it, one
              source it is searched on, whichever page it is opened from */}
          {watchId ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 text-ctl-sm">
                {initial.mediaId
                  ? t('watch.matchNow', {
                      title: folder?.title || initial.remotePath.split('/').pop(),
                      src: providerName(initial.mediaSource),
                      id: initial.mediaId,
                    })
                  : t('watch.matchNone')}
              </p>
              <Button type="button" size="sm" onClick={() => setMatching(true)}>
                {t('watch.matchChange')}
              </Button>
            </div>
          ) : (
            <p className="text-ctl-sm text-t-muted">{t('watch.matchFollows')}</p>
          )}
          {/* an explanation that failed (provider down) still opens it, on the
              source the match has: the button is the only way to correct */}
          {matching && (explained || unexplained) && (
            <RematchDialog
              serverId={serverId}
              item={{
                entry: { name: initial.remotePath.split('/').pop() ?? '', path: initial.remotePath } as Entry,
                source: explained?.source || initial.mediaSource,
              }}
              onClose={() => setMatching(false)}
              onPicked={() => {
                setMatching(false)
                void qc.invalidateQueries({ queryKey: ['watches'] })
                void qc.invalidateQueries({ queryKey: ['catalog-explain', serverId, initial.remotePath] })
                void qc.invalidateQueries({ queryKey: ['watch-defaults', serverId, initial.remotePath] })
              }}
            />
          )}
          {/* which of the record's episodes the local folder is held against;
              it counts with or without renaming, so it lives here */}
          {!manga && <FromEpisodeField rule={f} onChange={(patch) => setF({ ...f, ...patch })} idPrefix="watch" />}
        </section>

        {/* dub, subtitles, Plex tracks and episode names say nothing about a
            book: a manga watch only fetches, under the names it came with */}
        {manga && <p className="border-t border-border-subtle pt-4 text-ctl-sm text-t-muted">{t('watch.mangaHint')}</p>}
        {!manga && (
          <>
            <section className="ws-form-sec space-y-3" aria-label={t('watch.sectionFilter')}>
              <h3 className="ws-form-h">{t('watch.sectionFilter')}</h3>
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
                {f.wantDub && (
                  <Field
                    label={
                      <>
                        {t('watch.dubLag')}
                        <Hint text={t('watch.dubLagHint')} />
                      </>
                    }
                  >
                    <Input
                      type="number"
                      min={0}
                      max={365}
                      inputMode="numeric"
                      value={f.dubLagDays || ''}
                      placeholder="0"
                      onChange={(e) => setF({ ...f, dubLagDays: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                    />
                  </Field>
                )}
              </div>
            </section>

            {isAdmin && (tracks || (watchId && plexShow)) && (
              <section className="ws-form-sec space-y-3" aria-label={t('watch.sectionPlex')}>
                <h3 className="ws-form-h">{t('watch.sectionPlex')}</h3>
                {/* which show the track selection acts on. Only on an existing
                watch: the binding hangs on its series, which a watch that is
                not saved yet does not have. */}
                {watchId && plexShow && (
                  <PlexShowField watchId={watchId} state={plexShow} onDone={() => void refetchPlexShow()} />
                )}
                {tracks && (
                  <div className={ROW_GRID}>
                    {(['plexAudioLang', 'plexSubLang'] as const).map((key) => {
                      // Subtitles carry a second dimension the language cannot express:
                      // the forced track holds signs and foreign dialogue only. Both
                      // variants are offered per language and neither is derived from
                      // the audio - watching a dub with full subtitles and watching the
                      // original with signs only are both things people do on purpose.
                      const opts = plexStreamOptions(
                        key === 'plexAudioLang' ? langs.dub : langs.sub,
                        key === 'plexSubLang',
                      )
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
                )}
              </section>
            )}

            <section className="ws-form-sec space-y-3" aria-label={t('watch.sectionRename')}>
              <div className="flex items-center justify-between">
                <h3 className="ws-form-h">{t('watch.sectionRename')}</h3>
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
                    countField={false}
                    seriesQuery={f.remotePath.split('/').filter(Boolean).slice(-1)[0] || ''}
                    seasonFolder={{
                      name: f.localPath.split('/').findLast(Boolean) || '',
                      onUseParent: () =>
                        setF({ ...f, localPath: f.localPath.split('/').filter(Boolean).slice(0, -1).join('/') }),
                    }}
                  />
                </>
              )}
            </section>

            {pairs && <RenamePreview pairs={pairs} sizes={sizes} target={targetEntries} busy={previewBusy} />}
          </>
        )}

        {fsError && <FsErrorNote code={fsError.code} dir={fsError.dir} />}
        {error && (
          <p className="rounded-md border border-err/40 px-3 py-2 text-sm text-err" role="alert">
            {error}
          </p>
        )}
      </div>

      {/* the outcome belongs next to the button that caused it: in the
            scrollable body it would sit below the fold, which is exactly how
            the old notice above the page managed to stay unread */}
      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
        {notice && (
          <p className="mr-auto min-w-0 flex-1 text-ctl-sm text-warn" role="status">
            {notice}
          </p>
        )}
        <Button onClick={cancel}>
          <X aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('servers.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          <Save aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {saveLabel ?? t('settings.save')}
        </Button>
      </footer>
    </form>
  )
}
