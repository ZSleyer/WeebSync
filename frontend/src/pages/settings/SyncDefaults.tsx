import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth, useProviders } from '../../hooks'
import { useTranslation } from 'react-i18next'
import { FolderOpen } from 'lucide-react'
import { IconButton, Segmented, Select, SettingsField } from 'fluid-lycoris'
import { api, type KindDefaults, type WatchDefaults } from '../../api'
import SubfolderChoice from '../../components/SubfolderChoice'
import { LocalPicker } from '../../components/FileBrowser'
import PathInput, { trimSlashes } from '../../components/PathInput'
import { PRESETS, TITLE_LANGS } from '../../components/RenameOptions'
import { UnsavedGuard } from '../../hooks/useUnsavedGuard'
import { SaveBarView, useSettingsForm } from './useSettingsForm'
import { SettingsPanel, SwitchSetting, TextSetting } from './ui'

// The server stores the interval as a whole number and refuses a JSON float
const toInt = (v: string) => Math.trunc(Number(v)) || 0

const KINDS = ['anime-series', 'anime-movie', 'series', 'movie'] as const
type Kind = (typeof KINDS)[number]
const EMPTY_KIND: KindDefaults = {
  localPath: '',
  subfolder: false,
  subfolderSource: 'none',
  subfolderSeparator: '',
  template: '',
  separator: '',
}
const EMPTY: WatchDefaults = {
  kinds: {},
  common: {
    renameProvider: '',
    renameOrdering: '',
    renameTitleLang: '',
    airedMapping: false,
    wantDub: '',
    wantSub: '',
    dubLagDays: 0,
    plexAudioLang: '',
    plexSubLang: '',
  },
}

// chosen says whether anything was set for a kind: a folder, a template, a
// separator or a subfolder choice. The server keeps exactly these kinds.
const chosen = (k: KindDefaults) =>
  !!(k.localPath || k.template || k.separator || k.subfolderSeparator) ||
  (k.subfolderSource ?? (k.subfolder ? 'remote' : 'none')) !== 'none'

// What a new auto-sync or one-off sync starts from: a target folder and
// naming per media kind, and the rename and language choices shared by all
// of them. Applied wherever a watch dialog opens without a plan of its own,
// and to every proposal the assistant makes.
export default function SyncDefaults() {
  const { t } = useTranslation()
  // Plex track choices act on the admin's Plex account: an admin's
  const isAdmin = !!useAuth().data?.isAdmin
  const qc = useQueryClient()
  const { data } = useQuery<WatchDefaults>({
    queryKey: ['watch-defaults'],
    queryFn: () => api.get('/api/auth/watch-defaults'),
  })
  // the check interval is an instance setting, not a per-user default: the
  // admin's half of this page, saved through the settings form
  const inst = useSettingsForm({ enabled: isAdmin })
  const caps = useProviders()
  // what the form shows until the first edit: the stored defaults, filled up
  const stored = data
    ? { ...EMPTY, ...data, kinds: data.kinds ?? {}, common: { ...EMPTY.common, ...data.common } }
    : null
  const [edited, setForm] = useState<WatchDefaults | null>(null)
  const form = edited ?? stored ?? EMPTY
  const ids = useId()
  const [kind, setKind] = useState<Kind>('anime-series')
  const [browse, setBrowse] = useState(false)
  const [saved, setSaved] = useState(false)
  const defaultsDirty = !!stored && !!edited && JSON.stringify(edited) !== JSON.stringify(stored)
  const instForm = isAdmin ? inst.form : null
  const dirty = defaultsDirty || (!!instForm && inst.dirty)
  // a path still carrying the slash the picker appends is stored clean, and a
  // kind with nothing chosen is left out the way the server leaves it out, so
  // the saved state shown before the refetch is the one the refetch brings
  const tidy = (d: WatchDefaults): WatchDefaults => ({
    ...d,
    kinds: Object.fromEntries(
      Object.entries(d.kinds).flatMap(([c, k]) => {
        if (!k) return []
        const clean = { ...k, localPath: trimSlashes(k.localPath) }
        return chosen(clean) ? [[c, clean]] : []
      }),
    ),
  })
  const save = useMutation({
    meta: { silent: true },
    mutationFn: (d: WatchDefaults) => api.put('/api/auth/watch-defaults', tidy(d)),
    onSuccess: (_, d) => {
      setSaved(true)
      // the saved state is what the form shows from now on; the refetch confirms it
      qc.setQueryData(['watch-defaults'], tidy(d))
      setForm(null)
      qc.invalidateQueries({ queryKey: ['watch-defaults'] })
      setTimeout(() => setSaved(false), 1200)
    },
  })

  const k = form.kinds[kind] ?? EMPTY_KIND
  const setKindField = (patch: Partial<KindDefaults>) =>
    setForm({ ...form, kinds: { ...form.kinds, [kind]: { ...k, ...patch } } })
  const setCommon = (patch: Partial<WatchDefaults['common']>) =>
    setForm({ ...form, common: { ...form.common, ...patch } })
  const ordering =
    form.common.renameProvider && form.common.renameOrdering
      ? `${form.common.renameProvider}:${form.common.renameOrdering}`
      : ''

  return (
    <>
      <UnsavedGuard dirty={dirty} />
      <p className="text-ctl-sm text-t-muted">{t('settings.sync.intro')}</p>
      <SettingsPanel title={t('settings.sync.targets')} desc={t('settings.sync.targetsHint')}>
        <SettingsField label={t('settings.sync.kind')}>
          <Segmented
            aria-label={t('settings.sync.kind')}
            value={kind}
            onChange={setKind}
            options={KINDS.map((c) => ({ value: c, label: t(`watch.cat.${c}`) }))}
          />
        </SettingsField>
        <SettingsField label={t('watch.localPath')}>
          <div className="flex items-start gap-2">
            {/* the typed path is the form value itself: a value that only
                landed on Enter was lost when Save was clicked instead */}
            <PathInput
              value={k.localPath}
              onChange={(p) => setKindField({ localPath: p.replace(/^\//, '') })}
              onCommit={(p) => setKindField({ localPath: p.replace(/^\//, '') })}
              fetchPath={(p) => `/api/browse/local?path=${encodeURIComponent(p)}`}
              queryKey={['local']}
              ariaLabel={t('watch.localPath')}
            />
            <IconButton aria-expanded={browse} aria-label={t('rename.browse')} onClick={() => setBrowse((b) => !b)}>
              <FolderOpen aria-hidden size="1.2em" />
            </IconButton>
          </div>
          {browse && (
            <div className="t-scroll mt-2 max-h-56 rounded-lg border border-border-subtle">
              <LocalPicker path={k.localPath} onNavigate={(p) => setKindField({ localPath: p.replace(/^\//, '') })} />
            </div>
          )}
        </SettingsField>
        {/* subfolder mirrors the mode so a client reading only the bool
            still gets the remote-folder behaviour it knows */}
        <SubfolderChoice
          className="t-sf"
          value={k.subfolderSource ?? (k.subfolder ? 'remote' : 'none')}
          onChange={(m) => setKindField({ subfolderSource: m, subfolder: m === 'remote' })}
          separator={k.subfolderSeparator ?? ''}
          onSeparator={(sep) => setKindField({ subfolderSeparator: sep })}
        />
        <div className="sf-2">
          <TextSetting
            label={t('rename.template')}
            hint={
              <span className="flex flex-wrap gap-x-4">
                {PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className="t-link"
                    onClick={() => setKindField({ separator: '', ...p.patch })}
                  >
                    {t(p.key)}
                  </button>
                ))}
              </span>
            }
            mono
            value={k.template}
            placeholder="{title} - S{season:02}E{episode:02}"
            onChange={(v) => setKindField({ template: v })}
          />
          <SettingsField label={t('rename.separator')} htmlFor={ids + 'sep'}>
            <Select id={ids + 'sep'} value={k.separator} onChange={(e) => setKindField({ separator: e.target.value })}>
              <option value="">{t('rename.sepSpace')}</option>
              <option value="_">{t('rename.sepUnderscore')}</option>
              <option value=".">{t('rename.sepDot')}</option>
              <option value="-">{t('rename.sepDash')}</option>
            </Select>
          </SettingsField>
        </div>
      </SettingsPanel>

      <SettingsPanel title={t('settings.sync.common')} desc={t('settings.sync.commonHint')}>
        <div className="sf-2">
          <SettingsField label={t('watch.renameOrdering')} htmlFor={ids + 'ord'}>
            <Select
              id={ids + 'ord'}
              value={ordering}
              onChange={(e) => {
                const [p = '', o = ''] = e.target.value.split(':')
                setCommon({ renameProvider: p, renameOrdering: o })
              }}
            >
              <option value="">{t('watch.renameAuto')}</option>
              {caps?.tvdbApiKeySet && <option value="tvdb:official">TVDB Aired</option>}
              {caps?.tvdbApiKeySet && <option value="tvdb:dvd">TVDB DVD</option>}
              {caps?.tvdbApiKeySet && <option value="tvdb:absolute">{t('watch.renameTvdbAbsolute')}</option>}
              {caps?.tmdbApiKeySet && <option value="tmdb:aired">TMDB Aired</option>}
            </Select>
          </SettingsField>
          <SettingsField label={t('watch.renameTitleLang')} htmlFor={ids + 'tl'}>
            <Select
              id={ids + 'tl'}
              value={form.common.renameTitleLang}
              onChange={(e) => setCommon({ renameTitleLang: e.target.value })}
            >
              <option value="">{t('watch.titleLangOff')}</option>
              <option value="auto">{t('watch.langAuto')}</option>
              {TITLE_LANGS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </SettingsField>
        </div>
        <SwitchSetting
          label={t('settings.sync.aired')}
          hint={t('settings.sync.airedHint')}
          checked={form.common.airedMapping}
          onChange={(on) => setCommon({ airedMapping: on })}
        />
        <div className="sf-2">
          <TextSetting
            label={t('watch.wantDub')}
            mono
            value={form.common.wantDub}
            placeholder="Ger"
            onChange={(v) => setCommon({ wantDub: v.trim() })}
          />
          <TextSetting
            label={t('watch.wantSub')}
            mono
            value={form.common.wantSub}
            placeholder="Ger"
            onChange={(v) => setCommon({ wantSub: v.trim() })}
          />
          <TextSetting
            label={t('watch.dubLag')}
            type="number"
            min={0}
            max={365}
            inputMode="numeric"
            narrow
            value={form.common.dubLagDays || ''}
            placeholder="0"
            onChange={(v) => setCommon({ dubLagDays: Math.max(0, parseInt(v, 10) || 0) })}
          />
          <span aria-hidden className="hidden sm:block" />
          {isAdmin && (
            <>
              <TextSetting
                label={t('watch.plexAudio')}
                mono
                value={form.common.plexAudioLang}
                placeholder="Ger"
                onChange={(v) => setCommon({ plexAudioLang: v.trim() })}
              />
              <TextSetting
                label={t('watch.plexSub')}
                mono
                value={form.common.plexSubLang}
                placeholder="off, Ger, Ger:forced"
                onChange={(v) => setCommon({ plexSubLang: v.trim() })}
              />
            </>
          )}
        </div>
        <p className="sf-note">{t('settings.sync.langHint')}</p>
      </SettingsPanel>

      {instForm && (
        <SettingsPanel title={t('settings.sync.schedule')}>
          <TextSetting
            label={t('settings.watchInterval')}
            mono
            narrow
            type="number"
            inputMode="numeric"
            min={5}
            max={1440}
            step={1}
            value={instForm.watchIntervalMin}
            onChange={(v) => inst.set('watchIntervalMin', toInt(v))}
          />
        </SettingsPanel>
      )}

      <SaveBarView
        dirty={dirty}
        saved={saved || inst.saved}
        pending={save.isPending || inst.save.isPending}
        error={save.error?.message ?? inst.save.error?.message}
        onSave={() => {
          if (defaultsDirty) save.mutate(form)
          if (instForm && inst.dirty) inst.save.mutate(instForm)
        }}
        onDiscard={() => {
          save.reset()
          setForm(null)
          inst.save.reset()
          inst.reset()
        }}
      />
    </>
  )
}
