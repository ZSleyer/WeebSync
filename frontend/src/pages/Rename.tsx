import { useEffect, useState } from 'react'
import { FolderOpen, TriangleAlert } from 'lucide-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ActionBar, Badge, Button, Panel, useMediaQuery } from '@weebsync/design-system'
import { api, type RenamePair } from '../api'
import { LocalPicker } from '../components/FileBrowser'
import { PageFooter, WIDE_MQ } from '../components/PageActions'
import PathInput from '../components/PathInput'
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
  // desktop keeps the always-open picker column; a phone gets a path field
  // and opens the picker on demand, so the page has one scroller
  const wide = useMediaQuery(WIDE_MQ)
  const [browse, setBrowse] = useState(false)
  const [draft, setDraft] = useState('')

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
      <header className="mb-6 hidden lg:block">
        <h2 className="font-display text-xl font-semibold tracking-wider">{t('rename.title')}</h2>
        <Badge className="mt-1">{t('rename.sub')}</Badge>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(16rem,0.5fr)_1fr]">
        {wide ? (
          <Panel as="section" className="flex h-96 min-w-0 flex-col" aria-label={t('rename.folderSection')}>
            <div className="border-b border-border-subtle px-3 py-2">
              <Badge>
                {t('rename.folder')}: downloads/{path}
              </Badge>
            </div>
            <LocalPicker path={path} onNavigate={setPath} />
          </Panel>
        ) : (
          <Panel as="section" className="flex min-w-0 flex-col" aria-label={t('rename.folderSection')}>
            <div className="flex items-stretch gap-2 p-2">
              <PathInput
                value={browse ? path : draft || path}
                onChange={setDraft}
                onCommit={(p) => {
                  setPath(p.replace(/^\//, ''))
                  setDraft('')
                }}
                fetchPath={(p) => `/api/browse/local?path=${encodeURIComponent(p)}`}
                queryKey={['local']}
                ariaLabel={t('rename.folder')}
              />
              <Button size="sm" aria-expanded={browse} aria-label={t('rename.browse')} title={t('rename.browse')} onClick={() => setBrowse((b) => !b)}>
                <FolderOpen aria-hidden size="1.2em" />
              </Button>
            </div>
            {browse && (
              <div className="flex max-h-56 flex-col border-t border-border-subtle">
                <LocalPicker path={path} onNavigate={setPath} />
              </div>
            )}
          </Panel>
        )}

        <Panel as="section" className="min-w-0 space-y-3 p-4" aria-label={t('rename.rules')}>
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
          {(previewErr || doApply.error) && (
            <p className="text-sm text-err" role="alert">
              {previewErr || (doApply.error as Error).message}
            </p>
          )}
        </Panel>
      </div>

      {rows && (
        <Panel as="section" className="mt-4" aria-label={t('rename.result')}>
          {/* the scroller is an inner box: a scroll container on the panel
              itself would unstick the footer below */}
          <div className="overflow-x-auto">
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
                    <Badge>{t('rename.old')}</Badge>
                  </th>
                  <th className="px-3 py-2">
                    <Badge>{applied ? t('rename.applied') : t('rename.new')}</Badge>
                  </th>
                </tr>
              </thead>
              {/* break-anywhere: a file name has no spaces to break at, so its
                  length became the table's minimum width and pushed the panel
                  into a sideways scroll on a phone */}
              <tbody className="font-mono text-xs wrap-anywhere">
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
                      {p.error ? (
                        <>
                          <TriangleAlert aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
                          {p.error}
                        </>
                      ) : p.old === p.new ? (
                        t('rename.unchanged')
                      ) : (
                        p.new
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Apply stays reachable while the table scrolls: the shell's footer
              row on a phone, the preview panel's sticky footer on desktop */}
          {preview && (
            <PageFooter>
              <ActionBar aria-label={t('rename.apply')}>
                <Button variant="primary" cut disabled={picked.size === 0 || doApply.isPending} onClick={() => doApply.mutate()}>
                  {t('rename.apply')}
                </Button>
                {previewBusy ? <Badge>{t('app.loading')}</Badge> : <span className="text-xs text-t-muted">{t('dash.selectedCount', { count: picked.size })}</span>}
              </ActionBar>
            </PageFooter>
          )}
        </Panel>
      )}
    </div>
  )
}
