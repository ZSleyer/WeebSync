import { useId, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Link } from 'react-router'
import { Minus, Plus } from 'lucide-react'
import { IconButton, Input, SectionHeading, Select, Skeleton, TextLink } from 'fluid-lycoris'
import { api, ApiError } from '../api'
import type { Schemas } from '../api.gen'
import { ANILIST_SETTINGS } from '../anilistMe'
import ActionMenu from './ActionMenu'
import { useConfirm } from './confirm'
import { useFailToast, useToast } from './toast'
import { fromScale, scoreFormat, scoreMax, toScale, type ScoreFormat } from './anilistScore'
import './myAnilist.css'

type EntryResponse = Schemas['api.anilistEntryResponse']
type Entry = Schemas['anilist.ListEntryDetail']
type Status = Entry['status']
type Patch = { status?: Status; progress?: number; scoreRaw?: number }

const STATUSES: Status[] = ['CURRENT', 'PLANNING', 'COMPLETED', 'PAUSED', 'DROPPED', 'REPEATING']

const entryKey = (id: number) => ['anilist-entry', id]

/** "3 von 12", or the bare count while the total is unknown. */
export function progressText(n: number, total: number | undefined, t: TFunction): string {
  return total ? t('myAnilist.progressOf', { n, total }) : t('myAnilist.progressCount', { count: n })
}

/** A score in the user's own scale, in words where the scale is faces. */
export function scoreText(raw: number, f: ScoreFormat, t: TFunction): string {
  const v = toScale(raw, f)
  if (!v) return t('myAnilist.noScore')
  if (f === 'POINT_3') return t(`myAnilist.face${v}`)
  if (f === 'POINT_5') return t('myAnilist.stars', { count: v })
  return t('myAnilist.scoreOf', { v, max: scoreMax[f] })
}

/**
 * The user's own AniList entry for the title, on the series page: status,
 * progress and score, each changed in place (optimistic, rolled back with a
 * toast when AniList refuses). Read-only until the user allows list changes
 * in the settings; one quiet line to connect when no account is linked.
 * `onDisk` is how many episodes the user already has: past the progress it
 * offers to move it there, never on its own.
 */
export function MyAnilist({ mediaId, title, onDisk }: { mediaId: number; title: string; onDisk?: number }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const failToast = useFailToast()
  const toast = useToast()
  // the switch went off elsewhere: say so in the reader's words and show
  // the entry read-only again
  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 403) {
      toast({ message: t('myAnilist.turnedOff') })
      void qc.invalidateQueries({ queryKey: entryKey(mediaId) })
    } else failToast(e)
  }
  const confirm = useConfirm()
  const headId = useId()
  const q = useQuery({
    queryKey: entryKey(mediaId),
    queryFn: () => api.get<EntryResponse>(`/api/anilist/entry/${mediaId}`),
    staleTime: 60_000,
    retry: false,
  })
  const save = useMutation({
    // one request at a time per entry: parallel PUTs can arrive out of order
    // and a failed early one would roll the cache back over later successes
    scope: { id: `anilist-entry-${mediaId}` },
    mutationFn: (p: Patch) => api.put<EntryResponse>(`/api/anilist/entry/${mediaId}`, p),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: entryKey(mediaId) })
      const prev = qc.getQueryData<EntryResponse>(entryKey(mediaId))
      if (prev) {
        const base: Entry = prev.entry ?? {
          id: 0,
          status: 'PLANNING',
          progress: 0,
          scoreRaw: 0,
          repeat: 0,
          startedAt: { year: 0, month: 0, day: 0 },
          completedAt: { year: 0, month: 0, day: 0 },
          updatedAt: 0,
        }
        qc.setQueryData<EntryResponse>(entryKey(mediaId), { ...prev, entry: { ...base, ...p } })
      }
      return prev
    },
    onError: (e, _p, prev) => {
      // a rollback is only right when nothing newer is queued behind it
      if (prev && qc.isMutating({ predicate: (m) => m.options.scope?.id === `anilist-entry-${mediaId}` }) <= 1)
        qc.setQueryData(entryKey(mediaId), prev)
      fail(e)
    },
    onSuccess: (r) => {
      qc.setQueryData(entryKey(mediaId), r)
      qc.invalidateQueries({ queryKey: ['suggestions'] })
    },
    // the last of a burst settles on what AniList really holds
    onSettled: () => {
      if (qc.isMutating({ predicate: (m) => m.options.scope?.id === `anilist-entry-${mediaId}` }) <= 1)
        void qc.invalidateQueries({ queryKey: entryKey(mediaId) })
    },
  })
  const remove = useMutation({
    mutationFn: () => api.del<EntryResponse>(`/api/anilist/entry/${mediaId}`),
    onSuccess: (r) => {
      qc.setQueryData(entryKey(mediaId), r)
      qc.invalidateQueries({ queryKey: ['suggestions'] })
    },
    onError: (e) => fail(e),
  })

  const d = q.data
  const heading = (action?: ReactNode) => (
    <SectionHeading level={3} tone="accent-2" id={headId} title={t('myAnilist.title')} action={action} />
  )
  if (q.isPending)
    return (
      <section className="ws-my" aria-labelledby={headId}>
        {heading()}
        <div role="status" aria-label={t('app.loading')} className="grid gap-2">
          <Skeleton className="w-1/2" />
          <Skeleton className="w-1/3" />
        </div>
      </section>
    )
  if (q.isError)
    return (
      <section className="ws-my" aria-labelledby={headId}>
        {heading()}
        <p className="ws-d-err" role="status">
          {t('myAnilist.failed')}{' '}
          <TextLink tone="accent-2" onClick={() => void q.refetch()}>
            {t('thread.retry')}
          </TextLink>
        </p>
      </section>
    )
  if (!d?.linked)
    return (
      <p className="ws-my-quiet">
        {t('myAnilist.notLinked')}{' '}
        <Link className="t-link t-link--2" to={ANILIST_SETTINGS}>
          {t('myAnilist.connect')}
        </Link>
      </p>
    )

  const f = scoreFormat(d.scoreFormat)
  const e = d.entry
  const total = d.episodes || undefined
  const ahead = e && onDisk && onDisk > e.progress && (!total || onDisk <= total) ? onDisk : 0
  const askRemove = async () => {
    if (
      await confirm({
        title: t('myAnilist.remove'),
        message: t('myAnilist.removeConfirm', { title }),
        confirmLabel: t('myAnilist.remove'),
        destructive: true,
      })
    )
      remove.mutate()
  }

  if (!d.canEdit)
    return (
      <section className="ws-my" aria-labelledby={headId}>
        {heading()}
        <dl className="ws-my-ro">
          <div>
            <dt>{t('myAnilist.status')}</dt>
            <dd>{t(`myAnilist.st.${e?.status ?? 'NONE'}`)}</dd>
          </div>
          {e && (
            <div>
              <dt>{t('myAnilist.progress')}</dt>
              <dd>{progressText(e.progress, total, t)}</dd>
            </div>
          )}
          {e && (
            <div>
              <dt>{t('myAnilist.score')}</dt>
              <dd>{scoreText(e.scoreRaw, f, t)}</dd>
            </div>
          )}
        </dl>
        <p className="ws-my-quiet">
          {t('myAnilist.readOnly')}{' '}
          <Link className="t-link t-link--2" to={ANILIST_SETTINGS}>
            {t('myAnilist.allow')}
          </Link>
        </p>
      </section>
    )

  return (
    <section className="ws-my" aria-labelledby={headId}>
      {heading(
        e ? (
          <ActionMenu
            label={t('myAnilist.menu')}
            title={t('myAnilist.title')}
            actions={[{ key: 'remove', label: t('myAnilist.remove'), danger: true, onClick: () => void askRemove() }]}
          />
        ) : undefined,
      )}
      <div className="ws-my-grid">
        <Field label={t('myAnilist.status')}>
          {(id) => (
            <Select
              id={id}
              size="sm"
              value={e?.status ?? 'NONE'}
              onChange={(ev) => {
                const v = ev.target.value
                if (v === 'NONE') void askRemove()
                else save.mutate({ status: v as Status })
              }}
            >
              {!e && <option value="NONE">{t('myAnilist.st.NONE')}</option>}
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`myAnilist.st.${s}`)}
                </option>
              ))}
              {e && <option value="NONE">{t('myAnilist.st.NONE')}</option>}
            </Select>
          )}
        </Field>
        {e && (
          <Field label={t('myAnilist.progress')}>
            {(id) => (
              <Stepper
                key={e.progress}
                id={id}
                value={e.progress}
                max={total}
                text={progressText(e.progress, total, t)}
                lessLabel={t('myAnilist.less')}
                moreLabel={t('myAnilist.more')}
                onChange={(n) => save.mutate({ progress: n })}
              />
            )}
          </Field>
        )}
        {e && (
          <Field label={t('myAnilist.score')}>
            {(id) =>
              f === 'POINT_100' || f === 'POINT_10_DECIMAL' ? (
                <Stepper
                  key={e.scoreRaw}
                  id={id}
                  value={toScale(e.scoreRaw, f)}
                  max={scoreMax[f]}
                  step={f === 'POINT_100' ? 5 : 0.5}
                  decimal={f === 'POINT_10_DECIMAL'}
                  text={scoreText(e.scoreRaw, f, t)}
                  lessLabel={t('myAnilist.scoreLess')}
                  moreLabel={t('myAnilist.scoreMore')}
                  onChange={(v) => save.mutate({ scoreRaw: fromScale(v, f) })}
                />
              ) : (
                <Select
                  id={id}
                  size="sm"
                  value={String(toScale(e.scoreRaw, f))}
                  onChange={(ev) => save.mutate({ scoreRaw: fromScale(Number(ev.target.value), f) })}
                >
                  <option value="0">{t('myAnilist.noScore')}</option>
                  {Array.from({ length: scoreMax[f] }, (_, i) => scoreMax[f] - i).map((v) => (
                    <option key={v} value={String(v)}>
                      {scoreText(fromScale(v, f), f, t)}
                    </option>
                  ))}
                </Select>
              )
            }
          </Field>
        )}
      </div>
      {ahead > 0 && (
        <p className="ws-my-quiet">
          {t('myAnilist.onDisk', { count: ahead })}{' '}
          <TextLink tone="accent-2" onClick={() => save.mutate({ progress: ahead })}>
            {t('myAnilist.setTo', { n: ahead })}
          </TextLink>
        </p>
      )}
    </section>
  )
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="ws-my-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  )
}

/**
 * Minus, the number, plus: the buttons step at once, the field takes a typed
 * value on Enter or when it loses focus. `text` is the value in words for
 * screen readers ("3 von 12").
 */
function Stepper({
  id,
  value,
  max,
  step = 1,
  decimal,
  text,
  lessLabel,
  moreLabel,
  onChange,
}: {
  id: string
  value: number
  max?: number
  step?: number
  decimal?: boolean
  text: string
  lessLabel: string
  moreLabel: string
  onChange: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const clamp = (v: number) => Math.max(0, max ? Math.min(v, max) : v)
  const commit = () => {
    const v = Number(draft.replace(',', '.'))
    if (!Number.isFinite(v)) return setDraft(String(value))
    const next = clamp(decimal ? Math.round(v * 10) / 10 : Math.round(v))
    setDraft(String(next))
    if (next !== value) onChange(next)
  }
  return (
    <div className="ws-my-step">
      <IconButton aria-label={lessLabel} disabled={value <= 0} onClick={() => onChange(clamp(value - step))}>
        <Minus aria-hidden />
      </IconButton>
      <Input
        id={id}
        inputMode={decimal ? 'decimal' : 'numeric'}
        className="ws-my-num"
        value={draft}
        aria-describedby={id + '-t'}
        onChange={(ev) => setDraft(ev.target.value)}
        onBlur={commit}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') commit()
        }}
      />
      <span id={id + '-t'} className="sr-only">
        {text}
      </span>
      {max !== undefined && (
        <span aria-hidden className="ws-my-of">
          / {max}
        </span>
      )}
      <IconButton
        aria-label={moreLabel}
        disabled={max !== undefined && value >= max}
        onClick={() => onChange(clamp(value + step))}
      >
        <Plus aria-hidden />
      </IconButton>
    </div>
  )
}
