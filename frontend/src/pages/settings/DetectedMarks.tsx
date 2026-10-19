import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Ban, FolderOpen, FolderPlus } from 'lucide-react'
import { Badge, Row, Rows } from 'fluid-lycoris'
import { api, type DetectedMark, type DetectedMarks as DetectedMarksData } from '../../api'
import ActionMenu from '../../components/ActionMenu'
import type { SheetAction } from '../../components/ActionSheet'
import { filesLink } from '../../components/playLinks'
import { scopeChanged } from '../../components/useCatalogView'
import { useProviders } from '../../hooks'
import { scopeKindLabel } from '../today/needs'
import { SettingsPanel } from './ui'

/**
 * What became of a mark's subfolders: "370 matched: AniList 300 - TVDB 60 -
 * TMDB 10", then the ones without a match and the pending ones. Empty while the
 * index has not read the folder yet.
 */
export function titleSummary(t: TFunction, c: DetectedMark['titles']): string {
  if (!c || c.total === 0) return ''
  const providers = (
    [
      ['AniList', c.matched.anilist],
      ['TVDB', c.matched.tvdb],
      ['TMDB', c.matched.tmdb],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name} ${n}`)
  const matched = c.matched.anilist + c.matched.tvdb + c.matched.tmdb
  return [
    matched > 0 && `${t('servers.detectedMatched', { count: matched })}: ${providers.join(' · ')}`,
    c.noMatch > 0 && t('servers.detectedNoMatch', { count: c.noMatch }),
    c.pending > 0 && t('servers.detectedPending', { count: c.pending }),
  ]
    .filter(Boolean)
    .join(' · ')
}

const markId = (m: DetectedMark) => `${m.serverId}:${m.path}`

/**
 * The folders WeebSync marked on its own, newest first. Opening the list is
 * looking at it: the marks so far stop counting as new (Today's "Braucht dich"
 * row goes), the ones that were new stay flagged until the page is left. A row
 * can be changed to another source or switched off; either is the user's
 * decision and the folder is never marked again by WeebSync. Nothing shows
 * while there is nothing detected.
 */
export function DetectedMarks() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const caps = useProviders()
  const { data } = useQuery<DetectedMarksData>({
    queryKey: ['detected-marks'],
    queryFn: () => api.get('/api/catalog/detected-marks'),
  })
  // which rows were new when the list opened: the server forgets that at once
  const [fresh, setFresh] = useState<Set<string> | null>(null)
  if (data && fresh === null) setFresh(new Set(data.items.filter((m) => m.unseen).map(markId)))

  const seen = useMutation({
    mutationFn: () => api.post('/api/catalog/detected-marks/seen'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['detected-marks'] }),
  })
  const unseen = data?.unseen ?? 0
  const { mutate: markSeen } = seen
  useEffect(() => {
    if (unseen > 0) markSeen()
  }, [unseen, markSeen])

  const set = useMutation({
    mutationFn: ({ m, kind }: { m: DetectedMark; kind: string }) =>
      api.put(`/api/servers/${m.serverId}/catalog/scope`, { path: m.path, kind }),
    onSuccess: (_, { m }) => scopeChanged(qc, m.serverId),
    onSettled: () => qc.invalidateQueries({ queryKey: ['detected-marks'] }),
  })

  if (!data || data.items.length === 0) return null
  const kinds = [
    'auto',
    'anime',
    'manga',
    ...(caps.tmdbApiKeySet ? ['tv', 'movie'] : []),
    ...(caps.tvdbApiKeySet ? ['tvdb'] : []),
  ]
  const actions = (m: DetectedMark): SheetAction[] => {
    const ico = { 'aria-hidden': true, size: '1.1em' } as const
    return [
      ...kinds
        .filter((k) => k !== m.kind)
        .map((k) => ({
          key: k,
          label: t('servers.detectedAs', { kind: scopeKindLabel(t, k) }),
          icon: <FolderPlus {...ico} />,
          onClick: () => set.mutate({ m, kind: k }),
        })),
      {
        key: 'none',
        label: t('servers.detectedNone'),
        icon: <Ban {...ico} />,
        onClick: () => set.mutate({ m, kind: 'none' }),
      },
      {
        key: 'open',
        label: t('servers.detectedOpen'),
        icon: <FolderOpen {...ico} />,
        onClick: () => navigate(filesLink(m.serverId, m.path)),
      },
    ]
  }
  return (
    <SettingsPanel id="detected" title={t('servers.detected')} desc={t('servers.detectedHint')}>
      <Rows>
        {data.items.map((m) => (
          <Row
            key={markId(m)}
            title={
              <span className="break-words">
                {m.name} {fresh?.has(markId(m)) && <Badge tone="accent">{t('servers.detectedNew')}</Badge>}
              </span>
            }
            sub={
              <>
                <span className="break-words">{`${scopeKindLabel(t, m.kind)} · ${m.serverName}: ${m.path}`}</span>
                {titleSummary(t, m.titles) && <span className="block break-words">{titleSummary(t, m.titles)}</span>}
              </>
            }
            trailing={
              <ActionMenu label={t('servers.detectedActions', { name: m.name })} title={m.name} actions={actions(m)} />
            }
          />
        ))}
      </Rows>
    </SettingsPanel>
  )
}
