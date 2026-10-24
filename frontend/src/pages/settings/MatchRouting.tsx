import { useRef } from 'react'
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { IconButton, Switch } from 'fluid-lycoris'
import { api } from '../../api'
import type { Schemas } from '../../api.gen'
import { useDragReorder } from '../../hooks/useDragReorder'
import { useWholeSave } from '../../hooks'
import { SettingsPanel } from './ui'
import './matchRouting.css'

type Routing = Schemas['api.matchRouting']
type Entry = Schemas['api.routeEntry']
type Provider = Entry['provider']
type ListKey = 'animeSeries' | 'animeMovie' | 'series' | 'movie'

const PROVIDERS: Provider[] = ['anilist', 'tvdb', 'tmdb']
const LISTS: ListKey[] = ['animeSeries', 'animeMovie', 'series', 'movie']

interface Settings {
  matchRouting: Routing
  tmdbApiKeySet: boolean
  tvdbApiKeySet: boolean
}

// Which providers matching asks, and in which order: a switch per provider
// that turns it off for matching altogether, then one ordered list per kind of
// folder (anime series, anime films, series, films) that an "automatic" catalog
// mark and the match hints go by. A change is saved at once. A provider without
// a key is shown off and skipped, whatever its switch says.
export default function MatchRouting() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery<Settings>({ queryKey: ['settings'], queryFn: () => api.get('/api/settings') })
  // every change applies to the latest cached routing at once and the PUTs run
  // one after another (a held arrow key or a drag during a save loses nothing)
  const update = useWholeSave<Settings>(
    'settings',
    (s) => api.put('/api/settings', { matchRouting: s.matchRouting }),
    () => void qc.invalidateQueries({ queryKey: ['catalog'] }),
  )
  if (!data?.matchRouting) return null
  const r = data.matchRouting
  const hasKey = (p: Provider) => (p === 'tvdb' ? data.tvdbApiKeySet : p === 'tmdb' ? data.tmdbApiKeySet : true)
  const usable = (p: Provider) => r.providers[p] && hasKey(p)
  const off = !usable('anilist') && !usable('tvdb') && !usable('tmdb')
  const change = (edit: (r: Routing) => Routing) => update((cur) => ({ ...cur, matchRouting: edit(cur.matchRouting) }))

  return (
    <SettingsPanel title={t('settings.routing.title')} desc={t('settings.routing.desc')}>
      <div className="mr-switches">
        {PROVIDERS.map((p) => (
          <div className="mr-switch" key={p}>
            <Switch
              label={
                <span>
                  {t(`settings.routing.provider.${p}`)}
                  {!hasKey(p) && <span className="mr-note"> {t('settings.routing.noKey')}</span>}
                </span>
              }
              checked={r.providers[p] && hasKey(p)}
              disabled={!hasKey(p)}
              onChange={(e) => change((r) => ({ ...r, providers: { ...r.providers, [p]: e.target.checked } }))}
            />
          </div>
        ))}
      </div>
      <p className="mr-hint">{t('settings.routing.switchHint')}</p>
      {off && (
        <p className="sf-issue" role="status">
          {t('settings.routing.allOff')}
        </p>
      )}
      <div className="mr-lists">
        {LISTS.map((k) => (
          <RouteList
            key={k}
            kind={k}
            list={r[k]}
            hasKey={hasKey}
            switches={r.providers}
            onChange={(list) => change((r) => ({ ...r, [k]: list }))}
          />
        ))}
      </div>
    </SettingsPanel>
  )
}

function RouteList({
  kind,
  list,
  hasKey,
  switches,
  onChange,
}: {
  kind: ListKey
  list: Entry[]
  hasKey: (p: Provider) => boolean
  switches: Routing['providers']
  onChange: (list: Entry[]) => void
}) {
  const { t } = useTranslation()
  const ul = useRef<HTMLUListElement>(null)
  // the drag hook names rows by number: a provider's place in PROVIDERS
  const ids = list.map((e) => PROVIDERS.indexOf(e.provider))
  const move = (id: number, to: number) => {
    const from = ids.indexOf(id)
    if (from < 0 || from === to) return
    const next = [...list]
    next.splice(to, 0, ...next.splice(from, 1))
    onChange(next)
  }
  const handle = useDragReorder({ list: ul, ids, onMove: (id, to) => move(id, to) })
  const title = t(`settings.routing.list.${kind}`)
  const nothingOn = !list.some((e) => e.enabled && switches[e.provider] && hasKey(e.provider))
  return (
    <section className="mr-list" aria-labelledby={`mr-${kind}`}>
      <h4 id={`mr-${kind}`}>{title}</h4>
      <ul ref={ul}>
        {list.map((e, i) => {
          const id = PROVIDERS.indexOf(e.provider)
          const name = t(`settings.routing.provider.${e.provider}`)
          const blocked = !switches[e.provider] || !hasKey(e.provider)
          return (
            <li key={e.provider} data-reorder-id={id} className={blocked ? 'mr-row mr-blocked' : 'mr-row'}>
              <button
                type="button"
                {...handle(id)}
                aria-label={t('settings.routing.reorder', { name, list: title })}
                aria-keyshortcuts="ArrowUp ArrowDown Home End"
                className="mr-grip"
              >
                <GripVertical aria-hidden size="1.1em" />
              </button>
              <span className="mr-name">{name}</span>
              <IconButton
                size="sm"
                aria-label={t('settings.routing.up', { name })}
                disabled={i === 0}
                onClick={() => move(id, i - 1)}
              >
                <ArrowUp aria-hidden />
              </IconButton>
              <IconButton
                size="sm"
                aria-label={t('settings.routing.down', { name })}
                disabled={i === list.length - 1}
                onClick={() => move(id, i + 1)}
              >
                <ArrowDown aria-hidden />
              </IconButton>
              <Switch
                aria-label={t('settings.routing.use', { name, list: title })}
                checked={e.enabled}
                onChange={(ev) => onChange(list.map((x) => (x === e ? { ...x, enabled: ev.target.checked } : x)))}
              />
            </li>
          )
        })}
      </ul>
      {nothingOn && <p className="mr-hint">{t('settings.routing.emptyList')}</p>}
    </section>
  )
}
