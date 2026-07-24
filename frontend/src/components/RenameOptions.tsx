import { useEffect, useRef, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { api, type Media } from '../api'

// RenameRule is the part of a rename configuration that auto-sync and the
// rename page share; a watch carries more fields on top of it.
export interface RenameRule {
  mode: string // "template" | "regex"
  template: string
  separator: string
  titleOverride: string
  pattern: string
  replacement: string
  fromEpisode: number
  airedMapping: boolean
  renameProvider: string
  renameOrdering: string
  renameTitleLang: string
  renameSeriesId: number
}

// what the rename profile endpoint reports about the matched series
export interface RenameProfile {
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
}

export const TITLE_LANGS = ['de-DE', 'en-US', 'ja-JP', 'fr-FR', 'es-ES', 'it-IT', 'pt-BR', 'ru-RU', 'ko-KR', 'zh-CN']

const PRESETS = [
  { key: 'rename.presetPlex', patch: { template: '{title} - S{season:02}E{episode:02}' } },
  { key: 'rename.presetCompact', patch: { template: '{title}.S{season:02}E{episode:02}', separator: '.' } },
  { key: 'rename.presetGroup', patch: { template: '[{group}] {title} - {episode:02}' } },
  { key: 'rename.presetTags', patch: { template: '{title} - S{season:02}E{episode:02} [{dub}][{resolution}]' } },
]

// a folder like "Season 3" / "S02" / "Specials" - nesting "Season NN/" inside
// one of those is almost never what the user wants
const SEASON_FOLDER = /(?:season|staffel|saison|temporada|stagione)\s*\d+|^s\d{1,2}$|special/i
export const isSeasonFolder = (name: string) => SEASON_FOLDER.test(name)

// Hint renders a small "?" icon with a hover tooltip. The tooltip is portalled
// to the body with fixed positioning so the scroll container's overflow can't
// clip it and it never expands the scrollable area; it flips above the icon
// near the bottom edge and is clamped horizontally to stay on screen.
export function Hint({ text }: { text: string }) {
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
export function SeriesPicker({
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
          aria-label={t('remote.search')}
        />
        <button type="button" className="t-btn t-btn--sm" onClick={() => void search(q)}>
          {t('remote.search')}
        </button>
        <button type="button" className="t-btn t-btn--sm" onClick={onClose} aria-label={t('common.cancel')}>
          <X aria-hidden size="1.2em" />
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
                <ExternalLink aria-hidden size="1em" className="inline align-[-0.125em]" />
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// TitleSearch is an AniList search box that fills the title override. Fully
// keyboard accessible: results are focusable buttons, the list closes only
// when focus leaves the whole widget (WCAG 2.1.1).
export function TitleSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation()
  const [results, setResults] = useState<Media[]>([])
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const seq = useRef(0) // drop out-of-order responses while typing

  const search = async (q: string) => {
    onChange(q)
    const mySeq = ++seq.current
    if (q.length < 3) {
      setResults([])
      setOpen(false)
      return
    }
    try {
      const r = await api.get<Media[]>(`/api/anilist/search?q=${encodeURIComponent(q)}`)
      if (mySeq !== seq.current) return // a newer request superseded this one
      setResults(r)
      setOpen(true)
    } catch {
      /* ignore */
    }
  }

  const pick = (m: Media) => {
    onChange(m.title.romaji)
    setOpen(false)
  }

  return (
    <div
      ref={wrap}
      className="relative text-xs text-t-muted"
      onBlur={(e) => {
        if (!wrap.current?.contains(e.relatedTarget as Node)) setOpen(false)
      }}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
    >
      <label>
        {t('rename.titleOverride')}
        <input
          className="t-input mt-1"
          value={value}
          placeholder={t('rename.titlePlaceholder')}
          aria-expanded={open}
          onChange={(e) => search(e.target.value)}
        />
      </label>
      {open && results.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-50 max-h-48 overflow-y-auto border border-border-subtle bg-bg-card shadow-lg">
          {results.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="block w-full truncate px-3 py-1.5 text-left text-sm text-t-secondary hover:bg-bg-hover"
                onClick={() => pick(m)}
              >
                {m.title.romaji} <span className="text-t-muted">({m.seasonYear})</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// RenameOptions is the full rename rule editor: mode switch, template or
// regex, and the provider layer (localized title, aired-order mapping, series
// binding). Used by the watch dialog and the rename page, so both offer the
// same features - the two used to drift apart.
export default function RenameOptions({
  rule,
  onChange,
  caps,
  detected,
  idPrefix,
  seriesQuery,
  seasonFolder,
}: {
  rule: RenameRule
  onChange: (patch: Partial<RenameRule>) => void
  caps?: { tvdbApiKeySet?: boolean; tmdbApiKeySet?: boolean }
  detected?: RenameProfile | null
  idPrefix: string
  // what to search for when the user opens the series picker
  seriesQuery: string
  // set when the target folder can be moved up one level; the warning and its
  // fix button only make sense where a target folder is editable
  seasonFolder?: { name: string; onUseParent: () => void } | null
}) {
  const { t } = useTranslation()
  const [pickOpen, setPickOpen] = useState(false)
  const [pickedTitle, setPickedTitle] = useState('')

  return (
    <>
      <div className="flex gap-1" role="group" aria-label={t('rename.mode')}>
        <button
          type="button"
          aria-pressed={rule.mode === 'template'}
          className={`t-btn t-btn--sm ${rule.mode === 'template' ? 't-btn--primary' : ''}`}
          onClick={() => onChange({ mode: 'template' })}
        >
          {t('rename.template')}
        </button>
        <button
          type="button"
          aria-pressed={rule.mode === 'regex'}
          className={`t-btn t-btn--sm ${rule.mode === 'regex' ? 't-btn--primary' : ''}`}
          onClick={() => onChange({ mode: 'regex' })}
        >
          {t('rename.regex')}
        </button>
      </div>

      {rule.mode === 'template' ? (
        <>
          <div>
            <label className="mb-1 block w-fit text-xs text-t-muted" htmlFor={`${idPrefix}-template`}>
              {t('watch.template')}
              <Hint text={`${t('watch.templateHint')} ${t('watch.templatePadHint')}`} />
            </label>
            <input
              id={`${idPrefix}-template`}
              className="t-input font-mono"
              placeholder="{title} - S{season:02}E{episode:02}"
              value={rule.template}
              onChange={(e) => onChange({ template: e.target.value })}
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button key={p.key} type="button" className="t-btn t-btn--sm" onClick={() => onChange(p.patch)}>
                {t(p.key)}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-t-muted">
              {t('rename.separator')}
              <span className="t-select-wrap mt-1 block">
                <select
                  className="t-select"
                  value={rule.separator}
                  onChange={(e) => onChange({ separator: e.target.value })}
                >
                  <option value="">{t('rename.sepSpace')}</option>
                  <option value="_">{t('rename.sepUnderscore')}</option>
                  <option value=".">{t('rename.sepDot')}</option>
                  <option value="-">{t('rename.sepDash')}</option>
                </select>
              </span>
            </label>
            <TitleSearch value={rule.titleOverride} onChange={(v) => onChange({ titleOverride: v })} />
          </div>
        </>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-t-muted">
            {t('rename.pattern')}
            <input
              className="t-input mt-1 font-mono"
              value={rule.pattern}
              placeholder={'\\.S(\\d+)E(\\d+)\\.'}
              onChange={(e) => onChange({ pattern: e.target.value })}
            />
          </label>
          <label className="text-xs text-t-muted">
            {t('rename.replacement')}
            <input
              className="t-input mt-1 font-mono"
              value={rule.replacement}
              placeholder=" - S${1}E${2}."
              onChange={(e) => onChange({ replacement: e.target.value })}
            />
          </label>
        </div>
      )}

      <div>
        <label className="mb-1 block w-fit text-xs text-t-muted" htmlFor={`${idPrefix}-fromep`}>
          {t('watch.fromEpisode')}
          <Hint text={t('watch.fromEpisodeHint')} />
        </label>
        <input
          id={`${idPrefix}-fromep`}
          type="number"
          className="t-input font-mono"
          value={rule.fromEpisode || ''}
          placeholder="z.B. 26 (Dr. Stone S4E26)"
          onChange={(e) => onChange({ fromEpisode: Number(e.target.value) || 0 })}
        />
      </div>

      {rule.mode === 'template' && (
        <div className="space-y-4 border-t border-border-subtle pt-4">
          <span className="t-label block">{t('watch.sectionApiRename')}</span>
          {/* localized provider title as {title} - independent of aired mapping */}
          <label className="block text-xs text-t-muted">
            {t('watch.renameTitleLang')}
            <Hint text={t('watch.titleLangHint')} />
            <span className="t-select-wrap mt-1 block sm:max-w-xs">
              <select
                className="t-select"
                value={rule.renameTitleLang}
                onChange={(e) => onChange({ renameTitleLang: e.target.value })}
              >
                <option value="">{t('watch.titleLangOff')}</option>
                <option value="auto">{t('watch.langAuto')}</option>
                {TITLE_LANGS.map((l) => (
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
                checked={rule.airedMapping}
                onChange={(e) => {
                  const on = e.target.checked
                  // aired mapping wants season subfolders: prepend
                  // "Season NN/" automatically when the template lacks it
                  let template = rule.template
                  if (on && template && !/season\s*\{season/i.test(template)) {
                    template = `Season {season:02}/${template}`
                  }
                  onChange({ airedMapping: on, template })
                }}
              />
              {t('watch.airedMapping')}
              <Hint text={t('watch.airedMappingHint')} />
            </label>
            {rule.airedMapping && (
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
                      value={rule.renameProvider && rule.renameOrdering ? `${rule.renameProvider}:${rule.renameOrdering}` : ''}
                      onChange={(e) => {
                        const v = e.target.value
                        if (!v) onChange({ renameProvider: '', renameOrdering: '' })
                        else {
                          const [p, o] = v.split(':')
                          onChange({ renameProvider: p, renameOrdering: o })
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
                {seasonFolder && isSeasonFolder(seasonFolder.name) && (
                  // target is a season folder -> the template would nest
                  // "Season NN/" inside it; offer to move up to the series folder
                  <div className="space-y-1">
                    <p className="text-[11px] text-warn">{t('watch.localIsSeasonFolder', { folder: seasonFolder.name })}</p>
                    <button type="button" className="t-btn t-btn--sm" onClick={seasonFolder.onUseParent}>
                      {t('watch.useSeriesFolder')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* series binding: needed by the localized title and/or aired mapping */}
          {(rule.renameTitleLang !== '' || rule.airedMapping) && (
            <div className="space-y-2">
              <div className="flex items-start gap-2 text-xs">
                {detected?.seriesCover && (
                  <img src={detected.seriesCover} alt="" loading="lazy" className="h-14 w-10 shrink-0 object-cover" />
                )}
                <div className="min-w-0 flex-1">
                  <span className="text-t-muted">{t('watch.renameSeries')}: </span>
                  {rule.renameSeriesId ? (
                    <span className="text-t-primary">{pickedTitle || detected?.seriesTitle || `#${rule.renameSeriesId}`}</span>
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
                      <ExternalLink aria-hidden size="1em" className="inline align-[-0.125em]" />
                    </a>
                  )}
                  <button type="button" className="t-btn t-btn--sm ml-2" onClick={() => setPickOpen((v) => !v)}>
                    {t('watch.renameSeriesPick')}
                  </button>
                  {rule.renameSeriesId !== 0 && (
                    <button
                      type="button"
                      className="t-btn t-btn--sm ml-1"
                      onClick={() => {
                        onChange({ renameSeriesId: 0 })
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
                  provider={rule.renameProvider || detected?.seriesProvider || 'tvdb'}
                  initialQuery={detected?.showTitle || seriesQuery}
                  onPick={(id, ttl) => {
                    onChange({ renameSeriesId: id })
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
  )
}
