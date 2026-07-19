import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type Entry, type Media, type RenamePair } from '../api'
import { useConfirm } from './confirm'
import { FileBrowser, LocalPicker } from './FileBrowser'
import Loading from './Loading'

export interface WatchFields {
  remotePath: string
  localPath: string
  mode: string // "template" | "regex"
  template: string
  separator: string
  titleOverride: string
  pattern: string
  replacement: string
  subfolder: boolean
  mediaId: number
  mediaSource: string
  fromEpisode: number
  airedMapping: boolean
  renameProvider: string
  renameOrdering: string
  renameTitleLang: string
  renameSeriesId: number
  wantDub: string
  wantSub: string
}

// Hint renders a small "?" icon with a hover tooltip. The tooltip is portalled
// to the body with fixed positioning so the scroll container's overflow can't
// clip it and it never expands the scrollable area; it flips above the icon
// near the bottom edge and is clamped horizontally to stay on screen.
function Hint({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  // portal into the <dialog> (its top layer sits above everything); body would
  // render behind the modal backdrop
  const container = ref.current?.closest('dialog') ?? document.body
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const w = Math.min(256, window.innerWidth * 0.7)
    const tipH = 96
    let top = r.bottom + 4
    if (top + tipH > window.innerHeight) top = Math.max(4, r.top - tipH - 4)
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
    setPos({ top, left })
  }
  return (
    <span ref={ref} className="relative ml-1 inline-block align-middle">
      <button
        type="button"
        className="group/hint inline-flex h-6 w-6 items-center justify-center rounded align-middle focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        aria-label={text}
        onMouseEnter={show}
        onMouseLeave={() => setPos(null)}
        onFocus={show}
        onBlur={() => setPos(null)}
        onKeyDown={(e) => e.key === 'Escape' && setPos(null)}
        onClick={(e) => e.preventDefault()}
      >
        <span
          aria-hidden="true"
          className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border-subtle text-[10px] leading-none text-t-secondary group-hover/hint:border-accent group-hover/hint:text-accent"
        >
          ?
        </span>
      </button>
      {pos &&
        createPortal(
          <span
            role="tooltip"
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: 'min(256px, 70vw)' }}
            className="pointer-events-none z-[100] rounded border border-border-subtle bg-[#0d1117] p-2 text-[11px] font-normal normal-case leading-snug tracking-normal text-t-secondary shadow-lg"
          >
            {text}
          </span>,
          container,
        )}
    </span>
  )
}

// SeriesPicker is an inline title search for binding the rename series when the
// automatic match is ambiguous. Searches the given provider and calls onPick
// with the chosen id + title.
function SeriesPicker({
  provider,
  initialQuery,
  onPick,
  onClose,
}: {
  provider: string
  initialQuery: string
  onPick: (id: number, title: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState(initialQuery)
  const [results, setResults] = useState<Media[]>([])
  const path = provider === 'tmdb' ? `/api/tmdb/search?kind=tv&q=` : `/api/tvdb/search?q=`
  const search = async (term: string) => {
    if (!term.trim()) {
      setResults([])
      return
    }
    try {
      setResults(await api.get<Media[]>(`${path}${encodeURIComponent(term)}`))
    } catch {
      setResults([])
    }
  }
  // live search: results update as you type (debounced)
  useEffect(() => {
    const id = setTimeout(() => void search(q), 300)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])
  return (
    <div className="mt-2 border border-border-subtle p-2">
      <div className="mb-1 flex gap-1">
        <input
          className="t-input font-mono"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void search(q))}
          aria-label={t('browser.search')}
        />
        <button type="button" className="t-btn t-btn--sm" onClick={() => void search(q)}>
          {t('browser.search')}
        </button>
        <button type="button" className="t-btn t-btn--sm" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {results.map((m) => (
          <div key={m.id} className="flex gap-2 border-b border-border-subtle/50 px-1 py-1.5">
            {m.coverImage?.large && (
              <img src={m.coverImage.large} alt="" loading="lazy" className="h-16 w-11 shrink-0 object-cover" />
            )}
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => onPick(m.id, m.title.romaji || m.title.english)}
            >
              <div className="text-xs">
                <span className="text-t-primary">{m.title.romaji || m.title.english}</span>
                {m.title.english && m.title.english !== m.title.romaji && (
                  <span className="text-t-muted"> ({m.title.english})</span>
                )}
                {m.seasonYear > 0 && <span className="text-t-muted"> · {m.seasonYear}</span>}
              </div>
              {m.description && <p className="mt-0.5 line-clamp-2 text-[11px] text-t-muted">{m.description}</p>}
            </button>
            {m.siteUrl && (
              <a
                href={m.siteUrl}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 self-start text-t-muted hover:text-accent"
                aria-label={t('watch.openProvider')}
                title={t('watch.openProvider')}
                onClick={(e) => e.stopPropagation()}
              >
                ↗
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// WatchDialog collects the paths and rename rule of a watch (create from
// Browser, edit from the Watches page). Anatomy: fixed header, scrollable
// body in four sections (source&target / display metadata / language filter /
// rename+preview), sticky footer. The dry-run preview loads automatically.
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
  const { data: detected } = useQuery<{
    detected: boolean
    provider: string
    ordering: string
    language: string
    showTitle: string
    seriesProvider: string
    seriesId: number
    seriesTitle: string
    seriesOriginal: string
    seriesUrl: string
    seriesCover: string
    seriesOverview: string
    ambiguous: boolean
    candidates?: { id: number; title: string; year: number }[]
  }>({
    queryKey: ['rename-profile', serverId, f.remotePath, f.localPath, f.renameProvider],
    queryFn: () =>
      api.get(
        `/api/servers/${serverId}/rename-profile?path=${encodeURIComponent(f.remotePath)}&local=${encodeURIComponent(f.localPath)}&provider=${f.renameProvider}`,
      ),
    enabled: !!f.airedMapping && !!f.remotePath,
    retry: false,
    staleTime: 60_000,
  })
  const [pickOpen, setPickOpen] = useState(false)
  const [pickedTitle, setPickedTitle] = useState('')
  const [renameOn, setRenameOn] = useState(!!(initial.template || initial.pattern))
  const [browse, setBrowse] = useState<'remote' | 'local' | null>(null)
  // remote picker starts at the parent of the current watch folder
  const [browsePath, setBrowsePath] = useState(() =>
    initial.remotePath.split('/').filter(Boolean).slice(0, -1).join('/'),
  )
  // local picker always starts at the download root
  const [localBrowse, setLocalBrowse] = useState('')
  const [pairs, setPairs] = useState<RenamePair[] | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
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

  const hasRule = (f.mode === 'template' && !!f.template) || (f.mode === 'regex' && !!f.pattern)

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
        // send the full watch context so the preview applies the aired-order
        // mapping and localized title exactly like the real sync
        const next = names.length ? await api.post<RenamePair[]>('/api/rename/names', { names, serverId, ...f }) : []
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
  }, [
    renameOn,
    hasRule,
    serverId,
    f.remotePath,
    f.localPath,
    f.mode,
    f.template,
    f.separator,
    f.titleOverride,
    f.pattern,
    f.replacement,
    f.airedMapping,
    f.renameProvider,
    f.renameOrdering,
    f.renameTitleLang,
    f.renameSeriesId,
  ])

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
                        <Hint text={`${t('watch.templateHint')} ${t('watch.templatePadHint')}`} />
                      </label>
                      <input
                        id="watch-template"
                        className="t-input font-mono"
                        placeholder="{title} - S{season:02}E{episode:02}"
                        value={f.template}
                        onChange={(e) => setF({ ...f, template: e.target.value })}
                      />
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

                <div>
                  <label className="mb-1 block w-fit text-xs text-t-muted" htmlFor="watch-fromep">
                    {t('watch.fromEpisode')}
                    <Hint text={t('watch.fromEpisodeHint')} />
                  </label>
                  <input
                    id="watch-fromep"
                    type="number"
                    className="t-input font-mono"
                    value={f.fromEpisode || ''}
                    placeholder="z.B. 26 (Dr. Stone S4E26)"
                    onChange={(e) => setF({ ...f, fromEpisode: Number(e.target.value) || 0 })}
                  />
                </div>

                {f.mode === 'template' && (
                  <div className="space-y-4 border-t border-border-subtle pt-4">
                    <span className="t-label block">{t('watch.sectionApiRename')}</span>
                    {/* localized provider title as {title} - independent of aired mapping */}
                    <label className="block text-xs text-t-muted">
                      {t('watch.renameTitleLang')}
                      <Hint text={t('watch.titleLangHint')} />
                      <span className="t-select-wrap mt-1 block sm:max-w-xs">
                        <select
                          className="t-select"
                          value={f.renameTitleLang}
                          onChange={(e) => setF({ ...f, renameTitleLang: e.target.value })}
                        >
                          <option value="">{t('watch.titleLangOff')}</option>
                          <option value="auto">{t('watch.langAuto')}</option>
                          {['de-DE', 'en-US', 'ja-JP', 'fr-FR', 'es-ES', 'it-IT', 'pt-BR', 'ru-RU', 'ko-KR', 'zh-CN'].map((l) => (
                            <option key={l} value={l}>
                              {l}
                            </option>
                          ))}
                        </select>
                      </span>
                    </label>

                    {/* endless series: resolve aired-order season/episode */}
                    <div>
                      <label className="flex items-center gap-2 text-sm text-t-secondary">
                        <input
                          type="checkbox"
                          checked={f.airedMapping}
                          onChange={(e) => {
                            const on = e.target.checked
                            // aired mapping wants season subfolders: prepend
                            // "Season NN/" automatically when the template lacks it
                            let template = f.template
                            if (on && template && !/season\s*\{season/i.test(template)) {
                              template = `Season {season:02}/${template}`
                            }
                            setF({ ...f, airedMapping: on, template })
                          }}
                        />
                        {t('watch.airedMapping')}
                        <Hint text={t('watch.airedMappingHint')} />
                      </label>
                      {f.airedMapping && (
                        <div className="mt-4 space-y-4">
                          {detected?.detected && (
                            <p className="text-[11px] text-t-muted">
                              {t('watch.plexDetected', {
                                ordering: `${detected.provider || '?'} ${detected.ordering || ''}`.trim(),
                                lang: detected.language || t('watch.langAuto'),
                              })}
                            </p>
                          )}
                          <label className="block text-xs text-t-muted">
                            {t('watch.renameOrdering')}
                            <span className="t-select-wrap mt-1 block sm:max-w-xs">
                              <select
                                className="t-select"
                                value={f.renameProvider && f.renameOrdering ? `${f.renameProvider}:${f.renameOrdering}` : ''}
                                onChange={(e) => {
                                  const v = e.target.value
                                  if (!v) setF({ ...f, renameProvider: '', renameOrdering: '' })
                                  else {
                                    const [p, o] = v.split(':')
                                    setF({ ...f, renameProvider: p, renameOrdering: o })
                                  }
                                }}
                              >
                                <option value="">{t('watch.renameAuto')}</option>
                                {caps?.tvdbApiKeySet && <option value="tvdb:official">TVDB Aired</option>}
                                {caps?.tvdbApiKeySet && <option value="tvdb:dvd">TVDB DVD</option>}
                                {caps?.tvdbApiKeySet && <option value="tvdb:absolute">TVDB Absolut</option>}
                                {caps?.tmdbApiKeySet && <option value="tmdb:aired">TMDB Aired</option>}
                              </select>
                            </span>
                          </label>
                          {(() => {
                            const seg = f.localPath.split('/').filter(Boolean).pop() || ''
                            const isSeasonFolder = /(?:season|staffel|saison|temporada|stagione)\s*\d+|^s\d{1,2}$|special/i.test(seg)
                            if (isSeasonFolder) {
                              // local target is a season folder -> the template would nest
                              // "Season NN/" inside it; offer to move up to the series folder
                              return (
                                <div className="space-y-1">
                                  <p className="text-[11px] text-warn">{t('watch.localIsSeasonFolder', { folder: seg })}</p>
                                  <button
                                    type="button"
                                    className="t-btn t-btn--sm"
                                    onClick={() => setF({ ...f, localPath: f.localPath.split('/').filter(Boolean).slice(0, -1).join('/') })}
                                  >
                                    {t('watch.useSeriesFolder')}
                                  </button>
                                </div>
                              )
                            }
                            return null
                          })()}
                        </div>
                      )}
                    </div>

                    {/* series binding: needed by the localized title and/or aired mapping */}
                    {(f.renameTitleLang !== '' || f.airedMapping) && (
                      <div className="space-y-2">
                        <div className="flex items-start gap-2 text-xs">
                          {detected?.seriesCover && (
                            <img src={detected.seriesCover} alt="" loading="lazy" className="h-14 w-10 shrink-0 object-cover" />
                          )}
                          <div className="min-w-0 flex-1">
                            <span className="text-t-muted">{t('watch.renameSeries')}: </span>
                            {f.renameSeriesId ? (
                              <span className="text-t-primary">{pickedTitle || detected?.seriesTitle || `#${f.renameSeriesId}`}</span>
                            ) : detected?.ambiguous ? (
                              <span className="t-label t-label--warn">{t('watch.renameSeriesAmbiguous')}</span>
                            ) : (
                              <span className="text-t-primary">{detected?.seriesTitle || t('watch.renameAuto')}</span>
                            )}
                            {detected?.seriesOriginal && detected.seriesOriginal !== (pickedTitle || detected.seriesTitle) && (
                              <span className="text-t-muted"> ({detected.seriesOriginal})</span>
                            )}
                            {detected?.seriesUrl && (
                              <a
                                href={detected.seriesUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="ml-1 text-t-muted hover:text-accent"
                                aria-label={t('watch.openProvider')}
                                title={t('watch.openProvider')}
                              >
                                ↗
                              </a>
                            )}
                            <button type="button" className="t-btn t-btn--sm ml-2" onClick={() => setPickOpen((v) => !v)}>
                              {t('watch.renameSeriesPick')}
                            </button>
                            {f.renameSeriesId !== 0 && (
                              <button
                                type="button"
                                className="t-btn t-btn--sm ml-1"
                                onClick={() => {
                                  setF({ ...f, renameSeriesId: 0 })
                                  setPickedTitle('')
                                }}
                              >
                                {t('watch.renameAuto')}
                              </button>
                            )}
                            {detected?.seriesOverview && (
                              <p className="mt-1 line-clamp-2 text-[11px] text-t-muted">{detected.seriesOverview}</p>
                            )}
                          </div>
                        </div>
                        {pickOpen && (
                          <SeriesPicker
                            provider={f.renameProvider || detected?.seriesProvider || 'tvdb'}
                            initialQuery={detected?.showTitle || f.remotePath.split('/').filter(Boolean).slice(-1)[0] || ''}
                            onPick={(id, ttl) => {
                              setF({ ...f, renameSeriesId: id })
                              setPickedTitle(ttl)
                              setPickOpen(false)
                            }}
                            onClose={() => setPickOpen(false)}
                          />
                        )}
                        <div className="flex items-center gap-2">
                          <img
                            src="https://www.thetvdb.com/images/attribution/logo1.png"
                            alt="TheTVDB"
                            loading="lazy"
                            className="h-5 w-auto opacity-80"
                          />
                          <span className="text-[10px] text-t-muted">{t('watch.tvdbAttribution')}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
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
          <button type="button" className="t-btn" onClick={guardedClose}>
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
