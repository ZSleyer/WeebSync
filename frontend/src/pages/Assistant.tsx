import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Bot, Check, RefreshCw, Send, Sparkles, Square, Trash2, User as UserIcon } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge, Button, Dialog, EmptyState, MediaCard, Panel, Select, Textarea } from '@weebsync/design-system'
import {
  api,
  mediaTitle,
  streamAiChat,
  syncOutcome,
  type AiCard,
  type AiChatMessage,
  type AiProposal,
  type SyncResult,
  type UpgradeDims,
  type UpgradeSuggestion,
  type UpgradeVariant,
} from '../api'
import UpgradeCard, { type SyncRequest } from '../components/UpgradeCard'
import { usePersistedQuery } from '../hooks'
import MediaDetail from '../components/MediaDetail'
import { useAiModels, useAiStatus, useAuth } from '../hooks'
import WatchDialog, { type WatchFields } from '../components/WatchDialog'

// plain strips the markdown a model emits anyway (bold, code spans, heading
// marks): the page renders text, and the prompt asks for text.
const plain = (s: string) => s.replace(/\*\*(.*?)\*\*/g, '$1').replace(/`([^`\n]*)`/g, '$1').replace(/^#{1,6}\s+/gm, '')

// One turn of the conversation as rendered. Proposals hang off the assistant
// turn that produced them; `done` marks a card the user already confirmed.
// A step is one entry of the thinking transcript: a stretch of the model's
// reasoning, or a tool call with its arguments and the result it got back.
type Step =
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; name: string; params?: Record<string, unknown>; stats?: Record<string, unknown> }

interface Turn {
  role: 'user' | 'assistant'
  content: string
  proposals?: (AiProposal & { done?: boolean })[]
  cards?: AiCard[]
  upgrades?: UpgradeSuggestion[]
  steps?: Step[]
  stepsOpen?: boolean
  stepsTouched?: boolean // the user toggled the transcript; leave it alone
  tool?: string // the tool currently running, while streaming
  error?: string
}

// addStep appends to the transcript, merging consecutive reasoning deltas.
function addStep(tr: Turn, step: Step): Turn {
  const steps = [...(tr.steps ?? [])]
  const lastStep = steps[steps.length - 1]
  if (step.kind === 'reasoning' && lastStep?.kind === 'reasoning') {
    steps[steps.length - 1] = { kind: 'reasoning', text: lastStep.text + step.text }
  } else {
    steps.push(step)
  }
  return { ...tr, steps }
}

const EXAMPLES = ['seasonal', 'watch', 'upgrade'] as const

// The assistant chats over the user's own data and can only propose: every
// card opens the ordinary watch dialog, and what the dialog saves goes
// through the same endpoints the Suggestions page uses. The conversation
// lives in sessionStorage per user: gone with the tab, never in the DB. The
// model pick is per user too (localStorage), the admin's setting is the default.
export default function Assistant() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: user } = useAuth()
  const { data: status } = useAiStatus()
  const { data: models } = useAiModels(!!status?.configured)
  const uid = user?.id ?? 0
  const storageKey = `weebsync.ai.${uid}`
  const modelKey = `weebsync.ai.model.${uid}`
  const [turns, setTurns] = useState<Turn[]>(() => {
    try {
      const v = sessionStorage.getItem(`weebsync.ai.${uid}`)
      return v ? (JSON.parse(v) as Turn[]) : []
    } catch {
      return []
    }
  })
  const [model, setModel] = useState(() => {
    try {
      return localStorage.getItem(`weebsync.ai.model.${uid}`) ?? ''
    } catch {
      return ''
    }
  })
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [notice, setNotice] = useState('')
  const [open, setOpen] = useState<{ turn: number; idx: number } | null>(null)
  const [card, setCard] = useState<AiCard | null>(null)
  const [detail, setDetail] = useState<UpgradeSuggestion | null>(null)
  const [upSync, setUpSync] = useState<SyncRequest | null>(null)
  const [choice, setChoice] = useState<Record<string, UpgradeVariant>>({})
  const { data: dims } = usePersistedQuery<UpgradeDims>('upgrade-dims', () => api.get('/api/auth/upgrade-dims'))
  const abortRef = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(turns))
    } catch {
      /* storage full/blocked - the chat still works for this page load */
    }
    // keep the newest turn in view while it streams
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [turns, storageKey])
  useEffect(() => () => abortRef.current?.abort(), [])

  // a pick that the endpoint no longer serves falls back to the default
  const modelList = models?.models ?? []
  const effectiveModel = model && (modelList.length === 0 || modelList.includes(model)) ? model : ''
  const pickModel = (m: string) => {
    setModel(m)
    try {
      if (m) localStorage.setItem(modelKey, m)
      else localStorage.removeItem(modelKey)
    } catch {
      /* best effort */
    }
  }

  const patchLast = (fn: (turn: Turn) => Turn) =>
    setTurns((prev) => prev.map((tr, i) => (i === prev.length - 1 ? fn(tr) : tr)))

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim()
    if (!text || streaming) return
    const history: AiChatMessage[] = [...turns, { role: 'user' as const, content: text }]
      .filter((tr) => tr.content.trim())
      .map((tr) => ({ role: tr.role, content: tr.content }))
    setInput('')
    setTurns((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }])
    setStreaming(true)
    const ac = new AbortController()
    abortRef.current = ac
    try {
      await streamAiChat(
        history,
        (ev) => {
          switch (ev.type) {
            case 'delta':
              patchLast((tr) => ({ ...tr, content: tr.content + ev.text, tool: undefined }))
              break
            case 'reasoning':
              patchLast((tr) => ({ ...addStep(tr, { kind: 'reasoning', text: ev.text }), stepsOpen: tr.stepsTouched ? tr.stepsOpen : true }))
              break
            case 'tool': {
              // what the model said before calling a tool is its narration:
              // it belongs to the transcript, the answer starts after the tools
              patchLast((tr) => {
                const narrated = tr.content.trim() ? addStep(tr, { kind: 'reasoning', text: tr.content.trim() }) : tr
                return { ...addStep({ ...narrated, content: '' }, { kind: 'tool', name: ev.name, params: ev.params }), tool: ev.name, stepsOpen: tr.stepsTouched ? tr.stepsOpen : true }
              })
              break
            }
            case 'tool_done':
              patchLast((tr) => {
                const steps = [...(tr.steps ?? [])]
                for (let i = steps.length - 1; i >= 0; i--) {
                  const st = steps[i]
                  if (st.kind === 'tool' && st.name === ev.name && st.stats === undefined) {
                    steps[i] = { ...st, stats: ev.stats ?? {} }
                    break
                  }
                }
                return { ...tr, steps }
              })
              break
            case 'proposal': {
              const { type: _t, ...p } = ev
              patchLast((tr) => ({ ...tr, proposals: [...(tr.proposals ?? []), p] }))
              break
            }
            case 'cards':
              patchLast((tr) => ({ ...tr, cards: [...(tr.cards ?? []), ...ev.cards] }))
              break
            case 'upgrades':
              // the upgrades tool and show_upgrades may both name a card
              patchLast((tr) => {
                const have = new Set((tr.upgrades ?? []).map((u) => u.key))
                return { ...tr, upgrades: [...(tr.upgrades ?? []), ...ev.upgrades.filter((u) => !have.has(u.key))] }
              })
              break
            case 'error':
              patchLast((tr) => ({ ...tr, error: ev.message, tool: undefined }))
              break
            case 'done':
              // the transcript stays open while it is being written and folds
              // away with the answer, unless the user toggled it themselves
              patchLast((tr) => ({ ...tr, tool: undefined, stepsOpen: tr.stepsTouched ? tr.stepsOpen : false }))
              break
          }
        },
        ac.signal,
        effectiveModel,
      )
    } catch (e) {
      if (!ac.signal.aborted) {
        patchLast((tr) => ({ ...tr, error: e instanceof Error ? e.message : String(e), tool: undefined }))
      }
    } finally {
      patchLast((tr) => ({ ...tr, tool: undefined }))
      setStreaming(false)
      abortRef.current = null
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const clear = () => {
    abortRef.current?.abort()
    setTurns([])
    setNotice('')
  }

  if (status && !status.configured) {
    return (
      <div className="mx-auto max-w-2xl">
        <EmptyState label={t('assistant.title')}>
          <p>{t('assistant.unconfigured')}</p>
          {user?.isAdmin && (
            <p className="mt-2">
              <Link to="/settings/integrations" className="text-accent underline">
                {t('assistant.unconfiguredAdmin')}
              </Link>
            </p>
          )}
        </EmptyState>
      </div>
    )
  }

  const current = open ? turns[open.turn]?.proposals?.[open.idx] : undefined
  const last = turns.length - 1
  const empty = turns.length === 0

  // the composer is one element in two places: centred on the empty stage,
  // pinned to the bottom once the conversation exists
  const composer = (
    <form
      className="ai-composer flex items-end gap-3 p-2"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <label className="flex-1">
        <span className="sr-only">{t('assistant.placeholder')}</span>
        <Textarea
          rows={empty ? 3 : 2}
          className="w-full resize-none border-0 bg-transparent text-base"
          placeholder={t('assistant.placeholder')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          autoFocus
        />
      </label>
      {streaming ? (
        <Button type="button" onClick={() => abortRef.current?.abort()}>
          <Square aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('assistant.stop')}
        </Button>
      ) : (
        <Button type="submit" variant="primary" disabled={!input.trim()}>
          <Send aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('assistant.send')}
        </Button>
      )}
    </form>
  )

  const modelPicker = (
    <label className="flex items-center gap-2 text-xs text-t-muted">
      <span>{t('assistant.model')}</span>
      <Select size="sm" className="max-w-88 font-mono" value={effectiveModel} onChange={(e) => pickModel(e.target.value)}>
        <option value="">{t('assistant.modelDefault', { model: models?.default ?? status?.model ?? '' })}</option>
        {modelList
          .filter((m) => m !== (models?.default ?? status?.model))
          .map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
      </Select>
    </label>
  )

  if (empty) {
    return (
      <div className="ai-stage page-fill mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col justify-center py-6">
        <div className="ai-hero text-center">
          <span className="ai-glow mx-auto inline-block" aria-hidden>
            <span className="ai-orb ai-orb--lg">
              <Sparkles size="1.6em" />
            </span>
          </span>
          <h2 className="mt-5 font-display text-2xl font-semibold tracking-[0.12em] text-t-primary">{t('assistant.title')}</h2>
          <p className="mx-auto mt-3 max-w-xl text-base text-t-secondary">{t('assistant.intro')}</p>
        </div>
        <div className="mt-8">{composer}</div>
        <ul className="mt-4 grid gap-2 sm:grid-cols-3">
          {EXAMPLES.map((k) => (
            <li key={k} className="flex">
              <button type="button" className="ai-example flex-1 px-4 py-3 text-left text-sm" onClick={() => void send(t(`assistant.examples.${k}`))}>
                <Sparkles aria-hidden size="1em" className="mr-2 inline align-[-0.125em] text-accent" />
                {t(`assistant.examples.${k}`)}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex justify-center">{modelPicker}</div>
      </div>
    )
  }

  return (
    <div className="ai-stage page-fill mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="ai-glow" aria-hidden>
          <span className="ai-orb">
            <Sparkles size="1.1em" />
          </span>
        </span>
        <h2 className="font-display text-lg font-semibold tracking-[0.12em] text-t-primary">{t('assistant.title')}</h2>
        {notice && (
          <Badge tone="ok" role="status">
            {notice}
          </Badge>
        )}
        <div className="ml-auto">{modelPicker}</div>
        <Button size="sm" onClick={clear}>
          <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('assistant.clear')}
        </Button>
      </div>

      <div ref={logRef} role="log" aria-live="polite" aria-label={t('assistant.title')} className="min-h-0 flex-1 overflow-y-auto pr-1">
        <ol className="space-y-4">
          {turns.map((tr, ti) => (
            <li key={ti} className={`ai-turn flex items-start gap-3 ${tr.role === 'user' ? 'justify-end' : ''}`}>
              {tr.role === 'assistant' && (
                <span className="ai-glow shrink-0" aria-hidden>
                  <span className="ai-orb">
                    <Bot size="1.1em" />
                  </span>
                </span>
              )}
              <div className={`min-w-0 max-w-[88%] ${tr.role === 'user' ? 'order-first' : 'flex-1'}`}>
                <Panel className={`p-4 text-base leading-relaxed ${tr.role === 'user' ? 'ai-bubble--user' : 'ai-bubble'}`}>
                  <span className="sr-only">{tr.role === 'user' ? t('assistant.you') : t('assistant.title')}: </span>
                  {tr.steps?.length ? (
                    <details
                      className="ai-steps mb-3"
                      open={tr.stepsOpen ?? false}
                      onToggle={(e) => {
                        const isOpen = (e.target as HTMLDetailsElement).open
                        setTurns((prev) =>
                          prev.map((x, i) => (i === ti && isOpen !== (x.stepsOpen ?? false) ? { ...x, stepsOpen: isOpen, stepsTouched: true } : x)),
                        )
                      }}
                    >
                      <summary className="cursor-pointer text-sm text-t-muted">
                        {t('assistant.steps', { count: tr.steps.length })}
                      </summary>
                      <ol className="mt-2 space-y-2 border-l border-border-subtle pl-3 text-sm">
                        {tr.steps.map((st, si) =>
                          st.kind === 'reasoning' ? (
                            <li key={si} className="whitespace-pre-wrap wrap-break-word text-t-muted italic">
                              {st.text}
                            </li>
                          ) : (
                            <li key={si} className="text-t-secondary">
                              {toolSentence(t, st.name, 'start', st.params)}
                              {st.stats !== undefined && <span className="text-t-muted"> {toolSentence(t, st.name, 'done', st.stats)}</span>}
                            </li>
                          ),
                        )}
                      </ol>
                    </details>
                  ) : null}
                  {tr.content && (
                    <p className="whitespace-pre-wrap wrap-break-word">
                      {plain(tr.content)}
                      {streaming && ti === last && !tr.tool && <span className="ai-cursor" aria-hidden />}
                    </p>
                  )}
                  {tr.tool && (
                    <p className="mt-2 flex items-center gap-2 text-sm text-accent">
                      <RefreshCw aria-hidden size="1em" className="animate-spin motion-reduce:animate-none" />
                      {t('assistant.toolRunning', { name: t(`assistant.tools.${tr.tool}`, { defaultValue: tr.tool }) })}
                    </p>
                  )}
                  {!tr.content && !tr.tool && tr.role === 'assistant' && !tr.error && streaming && ti === last && (
                    <p className="flex items-center gap-2 text-sm text-t-muted">
                      <span className="ai-dots" aria-hidden>
                        <i />
                        <i />
                        <i />
                      </span>
                      {t('assistant.thinking')}
                    </p>
                  )}
                  {tr.error && (
                    <p className="mt-2 text-sm text-err" role="alert">
                      {t('assistant.error')}: {tr.error}
                    </p>
                  )}
                </Panel>
                {tr.cards?.length ? (
                  <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                    {tr.cards.map((c) => (
                      <li key={`${c.source}:${c.media.id}`}>
                        <MediaCard
                          className="ai-card h-full"
                          title={mediaTitle(c.media)}
                          cover={c.media.coverImage?.large}
                          meta={c.why}
                          badges={
                            <>
                              {c.media.seasonYear > 0 && <Badge size="sm">{c.media.seasonYear}</Badge>}
                              {c.media.format && <Badge size="sm">{c.media.format}</Badge>}
                              {c.media.averageScore > 0 && <Badge size="sm" tone="accent">{c.media.averageScore}</Badge>}
                            </>
                          }
                          actions={
                            <Button size="sm" onClick={() => setCard(c)} aria-label={t('remote.detailsFor', { name: mediaTitle(c.media) })}>
                              {t('remote.details')}
                            </Button>
                          }
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
                {tr.upgrades?.map((u) => (
                  <div key={u.key} className="mt-3">
                    <UpgradeCard
                      u={u}
                      dims={dims}
                      chosen={choice[u.key] ?? u.to}
                      onChoose={(o) => setChoice((c) => ({ ...c, [u.key]: o }))}
                      onSync={setUpSync}
                      onDetails={setDetail}
                    />
                  </div>
                ))}
                {tr.proposals?.map((p, pi) => (
                  <ProposalCard key={pi} p={p} onOpen={() => setOpen({ turn: ti, idx: pi })} />
                ))}
              </div>
              {tr.role === 'user' && (
                <span className="ai-orb ai-orb--user shrink-0" aria-hidden>
                  <UserIcon size="1.1em" />
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-4">{composer}</div>

      {card && (
        <Dialog width="max-w-3xl" aria-label={t('remote.detailsFor', { name: mediaTitle(card.media) })} onClose={() => setCard(null)}>
          <MediaDetail media={card.media} source={card.source} />
        </Dialog>
      )}
      {detail?.media && (
        <Dialog width="max-w-3xl" aria-label={t('remote.detailsFor', { name: detail.title })} onClose={() => setDetail(null)}>
          <MediaDetail media={detail.media} source={detail.providers?.includes('tmdb') ? 'tmdb:tv' : 'anilist'} />
        </Dialog>
      )}
      {upSync && (
        <WatchDialog
          title={upSync.name}
          serverId={upSync.serverId}
          initial={upSync.initial}
          info={upSync.info}
          saveLabel={t('suggestions.syncOnce')}
          onSave={async (f) => {
            const r = await api.post<SyncResult>('/api/downloads/sync', { serverId: upSync.serverId, ...f })
            const why = syncOutcome(r, t)
            if (why) return why
            qc.invalidateQueries({ queryKey: ['downloads'] })
            setNotice(t('remote.queued', { count: r.queued }))
          }}
          onClose={() => setUpSync(null)}
        />
      )}
      {open && current && (
        <WatchDialog
          title={current.title}
          serverId={current.serverId}
          initial={current.fields as unknown as WatchFields}
          info={current.info}
          saveLabel={current.kind === 'watch' ? undefined : t('suggestions.syncOnce')}
          onSave={async (f) => {
            if (current.kind === 'watch') {
              await api.post('/api/watches', { serverId: current.serverId, ...f })
              qc.invalidateQueries({ queryKey: ['watches'] })
              setNotice(t('watch.saved'))
            } else {
              const r = await api.post<SyncResult>('/api/downloads/sync', { serverId: current.serverId, ...f })
              const why = syncOutcome(r, t)
              if (why) return why
              qc.invalidateQueries({ queryKey: ['downloads'] })
              setNotice(t('remote.queued', { count: r.queued }))
            }
            setTurns((prev) =>
              prev.map((tr, i) =>
                i === open.turn
                  ? { ...tr, proposals: tr.proposals?.map((p, j) => (j === open.idx ? { ...p, done: true } : p)) }
                  : tr,
              ),
            )
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

// toolSentence phrases one transcript step from the tool's name, the
// parameters it was called with and the stats its result yielded. The
// locale carries one template per tool and phase; a tool without one gets
// the generic line.
function toolSentence(
  t: (k: string, o?: Record<string, unknown>) => string,
  name: string,
  phase: 'start' | 'done',
  data?: Record<string, unknown>,
): string {
  const d: Record<string, unknown> = { names: '', skippedNames: '', ...data }
  if (phase === 'done' && typeof d.error === 'string') return t('assistant.transcript.error', { error: d.error })
  let variant: string = phase
  if (phase === 'done' && name === 'recommend' && typeof d.skipped === 'number' && d.skipped > 0) variant = 'doneSkipped'
  if (phase === 'done' && name === 'propose' && d.ok === false) variant = 'rejected'
  const key = `assistant.transcript.${name}.${variant}`
  const generic = phase === 'start' ? t('assistant.transcript.generic.start', { name }) : t('assistant.transcript.generic.done', { name })
  return t(key, { ...d, defaultValue: generic })
}

function ProposalCard({ p, onOpen }: { p: AiProposal & { done?: boolean }; onOpen: () => void }) {
  const { t } = useTranslation()
  return (
    <Panel className="ai-proposal mt-3 p-4 text-base">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{t(`assistant.kind.${p.kind}`)}</Badge>
        <span className="font-display text-lg font-semibold">{p.title}</span>
        {p.unverified && <Badge tone="warn">{t('assistant.unverified')}</Badge>}
        {p.done && (
          <Badge tone="ok">
            <Check aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('assistant.done')}
          </Badge>
        )}
      </div>
      <p className="mt-2 break-all font-mono text-sm text-t-muted">
        {p.serverName}: {p.remotePath}
      </p>
      {p.info?.length ? (
        <ul className="mt-2 list-inside list-disc text-sm text-t-secondary">
          {p.info.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
      {!p.done && (
        <Button variant="primary" className="mt-3" onClick={onOpen}>
          <Sparkles aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {p.kind === 'watch' ? t('assistant.create') : t('assistant.queue')}
        </Button>
      )}
    </Panel>
  )
}
