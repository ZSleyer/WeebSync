import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type RenamePair } from '../api'
import { LocalPicker } from '../components/FileBrowser'
import RenameOptions, { type RenameRule } from '../components/RenameOptions'

const EMPTY_RULE: RenameRule = {
  mode: 'template',
  template: '{title} - S{season:02}E{episode:02}',
  separator: '_',
  titleOverride: '',
  pattern: '',
  replacement: '',
  fromEpisode: 0,
  airedMapping: false,
  renameProvider: '',
  renameOrdering: '',
  renameTitleLang: '',
  renameSeriesId: 0,
}

export default function Rename() {
  const { t } = useTranslation()
  const [path, setPath] = useState('')
  const [rule, setRule] = useState<RenameRule>(EMPTY_RULE)
  const [preview, setPreview] = useState<RenamePair[] | null>(null)
  const [applied, setApplied] = useState<RenamePair[] | null>(null)
  // which previewed renames actually get applied; keyed by old name
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewErr, setPreviewErr] = useState('')

  const { data: caps } = useQuery<{ tvdbApiKeySet?: boolean; tmdbApiKeySet?: boolean }>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
    retry: false,
    staleTime: 5 * 60_000,
  })

  const hasRule = (rule.mode === 'template' && !!rule.template) || (rule.mode === 'regex' && !!rule.pattern)
  const renameable = (p: RenamePair) => !p.error && p.old !== p.new

  // live preview, debounced against typing - same behaviour as the watch dialog
  useEffect(() => {
    if (!hasRule) {
      setPreview(null)
      return
    }
    let stale = false // an in-flight preview must not overwrite a newer one
    const run = setTimeout(async () => {
      setPreviewBusy(true)
      setPreviewErr('')
      try {
        const next = await api.post<RenamePair[]>('/api/rename/preview', { path, ...rule })
        if (stale) return
        setPreview(next)
        setApplied(null)
        setPicked(new Set(next.filter(renameable).map((p) => p.old)))
      } catch (e) {
        if (!stale) {
          setPreview(null)
          setPreviewErr((e as Error).message)
        }
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
    path,
    hasRule,
    rule.mode,
    rule.template,
    rule.separator,
    rule.titleOverride,
    rule.pattern,
    rule.replacement,
    rule.fromEpisode,
    rule.airedMapping,
    rule.renameProvider,
    rule.renameOrdering,
    rule.renameTitleLang,
    rule.renameSeriesId,
  ])

  const doApply = useMutation({
    mutationFn: () =>
      api.post<RenamePair[]>('/api/rename/apply', {
        path,
        renames: preview!.filter((p) => renameable(p) && picked.has(p.old)),
      }),
    onSuccess: (r) => {
      setApplied(r)
      setPreview(null)
    },
  })

  const toggle = (old: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (!next.delete(old)) next.add(old)
      return next
    })

  const rows = preview ?? applied
  const selectable = preview?.filter(renameable) ?? []

  return (
    <div>
      <header className="mb-6">
        <h2 className="font-display text-xl font-semibold tracking-wider">{t('rename.title')}</h2>
        <span className="t-label mt-1">{t('rename.sub')}</span>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(16rem,0.5fr)_1fr]">
        <section className="t-panel flex h-96 min-w-0 flex-col" aria-label={t('rename.folderSection')}>
          <div className="border-b border-border-subtle px-3 py-2">
            <span className="t-label">
              {t('rename.folder')}: downloads/{path}
            </span>
          </div>
          <LocalPicker path={path} onNavigate={setPath} />
        </section>

        <section className="t-panel min-w-0 space-y-3 p-4" aria-label={t('rename.rules')}>
          <RenameOptions
            rule={rule}
            onChange={(patch) => setRule({ ...rule, ...patch })}
            caps={caps}
            idPrefix="rename"
            seriesQuery={path.split('/').filter(Boolean).slice(-1)[0] || ''}
            seasonFolder={{
              name: path.split('/').filter(Boolean).pop() || '',
              onUseParent: () => setPath(path.split('/').filter(Boolean).slice(0, -1).join('/')),
            }}
          />

          <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
            <button
              className="t-btn t-btn--primary t-cut"
              disabled={picked.size === 0 || doApply.isPending}
              onClick={() => doApply.mutate()}
            >
              {t('rename.apply')}
            </button>
            {previewBusy && <span className="t-label">{t('app.loading')}</span>}
            {!previewBusy && preview && (
              <span className="text-xs text-t-muted">{t('dash.selectedCount', { count: picked.size })}</span>
            )}
          </div>
          {(previewErr || doApply.error) && (
            <p className="text-sm text-err" role="alert">
              {previewErr || (doApply.error as Error).message}
            </p>
          )}
        </section>
      </div>

      {rows && (
        <section className="t-panel mt-4 overflow-x-auto" aria-label={t('rename.result')}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left">
                <th className="w-10 px-3 py-2">
                  {preview && selectable.length > 0 && (
                    <input
                      type="checkbox"
                      aria-label={t('dash.selectAll')}
                      checked={picked.size === selectable.length}
                      onChange={(e) => setPicked(new Set(e.target.checked ? selectable.map((p) => p.old) : []))}
                    />
                  )}
                </th>
                <th className="px-3 py-2">
                  <span className="t-label">{t('rename.old')}</span>
                </th>
                <th className="px-3 py-2">
                  <span className="t-label">{applied ? t('rename.applied') : t('rename.new')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              {rows.map((p, i) => (
                <tr key={i} className="border-b border-border-subtle/50">
                  <td className="px-3 py-1.5">
                    {preview && renameable(p) && (
                      <input
                        type="checkbox"
                        aria-label={t('dash.select', { name: p.old })}
                        checked={picked.has(p.old)}
                        onChange={() => toggle(p.old)}
                      />
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-t-muted">{p.old}</td>
                  <td
                    className={`px-3 py-1.5 ${p.error ? 'text-err' : p.old === p.new ? 'text-t-muted' : applied ? 'text-ok' : 'text-accent'}`}
                  >
                    {p.error ? `⚠ ${p.error}` : p.old === p.new ? t('rename.unchanged') : p.new}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
