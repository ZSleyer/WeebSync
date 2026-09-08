import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { FolderOpen } from 'lucide-react'
import { ActionBar, Badge, Button, Field, Input, Panel, Segmented, Select } from '@weebsync/design-system'
import { api, type KindDefaults, type WatchDefaults } from '../../api'
import { LocalPicker } from '../../components/FileBrowser'
import PathInput from '../../components/PathInput'
import { PageFooter } from '../../components/PageActions'
import { PRESETS, ROW_GRID, TITLE_LANGS } from '../../components/RenameOptions'
import { UnsavedGuard } from '../../hooks/useUnsavedGuard'

const KINDS = ['anime-series', 'anime-movie', 'series', 'movie'] as const
type Kind = (typeof KINDS)[number]
const EMPTY_KIND: KindDefaults = { localPath: '', subfolder: false, template: '', separator: '' }
const EMPTY: WatchDefaults = {
  kinds: {},
  common: { renameProvider: '', renameOrdering: '', renameTitleLang: '', airedMapping: false, wantDub: '', wantSub: '', plexAudioLang: '', plexSubLang: '' },
}

// What a new auto-sync or one-off sync starts from: a target folder and
// naming per media kind, and the rename and language choices shared by all
// of them. Applied wherever a watch dialog opens without a plan of its own,
// and to every proposal the assistant makes.
export default function SyncDefaults() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery<WatchDefaults>({ queryKey: ['watch-defaults'], queryFn: () => api.get('/api/auth/watch-defaults') })
  const { data: caps } = useQuery<{ tvdbApiKeySet?: boolean; tmdbApiKeySet?: boolean }>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
    retry: false,
    staleTime: 5 * 60_000,
  })
  const [form, setForm] = useState<WatchDefaults>(EMPTY)
  const [loaded, setLoaded] = useState<string>('')
  const [kind, setKind] = useState<Kind>('anime-series')
  const [browse, setBrowse] = useState(false)
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (data) {
      const d = { ...EMPTY, ...data, kinds: data.kinds ?? {}, common: { ...EMPTY.common, ...data.common } }
      setForm(d)
      setLoaded(JSON.stringify(d))
    }
  }, [data])
  const dirty = loaded !== '' && JSON.stringify(form) !== loaded
  const save = useMutation({
    mutationFn: (d: WatchDefaults) => api.put('/api/auth/watch-defaults', d),
    onSuccess: () => {
      setSaved(true)
      setLoaded(JSON.stringify(form))
      qc.invalidateQueries({ queryKey: ['watch-defaults'] })
      setTimeout(() => setSaved(false), 3000)
    },
  })

  const k = form.kinds[kind] ?? EMPTY_KIND
  const setKindField = (patch: Partial<KindDefaults>) => setForm({ ...form, kinds: { ...form.kinds, [kind]: { ...k, ...patch } } })
  const setCommon = (patch: Partial<WatchDefaults['common']>) => setForm({ ...form, common: { ...form.common, ...patch } })
  const ordering = form.common.renameProvider && form.common.renameOrdering ? `${form.common.renameProvider}:${form.common.renameOrdering}` : ''

  return (
    <>
      <UnsavedGuard dirty={dirty} />
      <Panel as="section" className="mb-4 p-5" aria-label={t('settings.sync.targets')}>
        <Badge tone="accent">{t('settings.sync.targets')}</Badge>
        <p className="mt-2 mb-3 text-xs text-t-muted">{t('settings.sync.targetsHint')}</p>
        <Segmented
          aria-label={t('settings.sync.targets')}
          className="mb-4"
          value={kind}
          onChange={(v) => {
            setKind(v)
            setDraft('')
          }}
          options={KINDS.map((c) => ({ value: c, label: t(`watch.cat.${c}`) }))}
        />
        <div className="space-y-3">
          <Field label={t('watch.localPath')}>
            <div className="flex items-start gap-2">
              <PathInput
                value={draft || k.localPath}
                onChange={setDraft}
                onCommit={(p) => {
                  setKindField({ localPath: p.replace(/^\//, '') })
                  setDraft('')
                }}
                fetchPath={(p) => `/api/browse/local?path=${encodeURIComponent(p)}`}
                queryKey={['local']}
                ariaLabel={t('watch.localPath')}
              />
              <Button size="sm" aria-expanded={browse} aria-label={t('rename.browse')} title={t('rename.browse')} onClick={() => setBrowse((b) => !b)}>
                <FolderOpen aria-hidden size="1.2em" />
              </Button>
            </div>
            {browse && (
              <div className="mt-2 max-h-56 overflow-y-auto border border-border-subtle">
                <LocalPicker path={k.localPath} onNavigate={(p) => setKindField({ localPath: p.replace(/^\//, '') })} />
              </div>
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm text-t-secondary">
            <input type="checkbox" checked={k.subfolder} onChange={(e) => setKindField({ subfolder: e.target.checked })} />
            {t('watch.subfolder')}
          </label>
          <div className={ROW_GRID}>
            <Field label={t('rename.template')}>
              <Input className="font-mono" value={k.template} placeholder="{title} - S{season:02}E{episode:02}" onChange={(e) => setKindField({ template: e.target.value })} />
            </Field>
            <Field label={t('rename.separator')}>
              <Select value={k.separator} onChange={(e) => setKindField({ separator: e.target.value })}>
                <option value="">{t('rename.sepSpace')}</option>
                <option value="_">{t('rename.sepUnderscore')}</option>
                <option value=".">{t('rename.sepDot')}</option>
                <option value="-">{t('rename.sepDash')}</option>
              </Select>
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <Button key={p.key} size="sm" onClick={() => setKindField({ separator: '', ...p.patch })}>
                {t(p.key)}
              </Button>
            ))}
          </div>
        </div>
      </Panel>

      <Panel as="section" className="mb-4 p-5" aria-label={t('settings.sync.common')}>
        <Badge tone="accent">{t('settings.sync.common')}</Badge>
        <p className="mt-2 mb-3 text-xs text-t-muted">{t('settings.sync.commonHint')}</p>
        <div className={ROW_GRID}>
          <Field label={t('watch.renameOrdering')}>
            <Select
              value={ordering}
              onChange={(e) => {
                const [p = '', o = ''] = e.target.value.split(':')
                setCommon({ renameProvider: p, renameOrdering: o })
              }}
            >
              <option value="">{t('watch.renameAuto')}</option>
              {caps?.tvdbApiKeySet && <option value="tvdb:official">TVDB Aired</option>}
              {caps?.tvdbApiKeySet && <option value="tvdb:dvd">TVDB DVD</option>}
              {caps?.tvdbApiKeySet && <option value="tvdb:absolute">TVDB Absolut</option>}
              {caps?.tmdbApiKeySet && <option value="tmdb:aired">TMDB Aired</option>}
            </Select>
          </Field>
          <Field label={t('watch.renameTitleLang')}>
            <Select value={form.common.renameTitleLang} onChange={(e) => setCommon({ renameTitleLang: e.target.value })}>
              <option value="">{t('watch.titleLangOff')}</option>
              <option value="auto">{t('watch.langAuto')}</option>
              {TITLE_LANGS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-sm text-t-secondary sm:col-span-2">
            <input type="checkbox" checked={form.common.airedMapping} onChange={(e) => setCommon({ airedMapping: e.target.checked })} />
            {t('watch.airedMapping')}
          </label>
          <Field label={t('watch.wantDub')}>
            <Input className="font-mono" value={form.common.wantDub} placeholder="Ger" onChange={(e) => setCommon({ wantDub: e.target.value.trim() })} />
          </Field>
          <Field label={t('watch.wantSub')}>
            <Input className="font-mono" value={form.common.wantSub} placeholder="Ger" onChange={(e) => setCommon({ wantSub: e.target.value.trim() })} />
          </Field>
          <Field label={t('watch.plexAudio')}>
            <Input className="font-mono" value={form.common.plexAudioLang} placeholder="Ger" onChange={(e) => setCommon({ plexAudioLang: e.target.value.trim() })} />
          </Field>
          <Field label={t('watch.plexSub')}>
            <Input className="font-mono" value={form.common.plexSubLang} placeholder="off, Ger, Ger:forced" onChange={(e) => setCommon({ plexSubLang: e.target.value.trim() })} />
          </Field>
        </div>
        <p className="mt-3 text-xs text-t-muted">{t('settings.sync.langHint')}</p>
      </Panel>

      <PageFooter>
        <ActionBar aria-label={t('settings.save')} sticky={false} className="lg:mb-6">
          <Button variant="primary" cut onClick={() => save.mutate(form)} disabled={save.isPending}>
            {t('settings.save')}
          </Button>
          {saved && (
            <Badge tone="ok" role="status">
              {t('settings.saved')}
            </Badge>
          )}
          {save.error && (
            <span className="text-sm text-err" role="alert">
              {save.error.message}
            </span>
          )}
        </ActionBar>
      </PageFooter>
    </>
  )
}
