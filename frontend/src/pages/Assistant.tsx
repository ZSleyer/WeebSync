import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronRight, Cpu, RefreshCw, Send, Sparkles, Square, Trash2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge, Button, Dialog, EmptyState, MediaCard, Menu, MenuItem, Panel, Textarea, navItemClass, useMediaQuery, useMenu } from '@weebsync/design-system'
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
import PageActions, { WIDE_MQ } from '../components/PageActions'
import WatchDialog, { type WatchFields } from '../components/WatchDialog'
import { applyDefaults, useWatchDefaults } from '../components/watchDefaults'
import { useConfirm } from '../components/confirm'

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
  proposals?: (AiProposal & { done?: boolean; error?: string })[]
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
  const wide = useMediaQuery(WIDE_MQ)
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
  const { data: defaults } = useWatchDefaults()
  const confirm = useConfirm()
  const [choice, setChoice] = useState<Record<string, UpgradeVariant>>({})
  const { data: dims } = usePersistedQuery<UpgradeDims>('upgrade-dims', () => api.get('/api/auth/upgrade-dims'))
  const abortRef = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const { open: modelOpen, setOpen: setModelOpen, ref: modelRef } = useMenu()

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
    // cards and proposals arrive while tools run, before the answer is
    // written; shown right away they push the streaming text around. They
    // wait here and land below the answer once the stream ends, however it
    // ends (done, error, abort) - nothing accepted gets lost
    const pending: { proposals: NonNullable<Turn['proposals']>; cards: AiCard[]; upgrades: UpgradeSuggestion[] } = { proposals: [], cards: [], upgrades: [] }
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
              pending.proposals.push(p)
              break
            }
            case 'cards':
              pending.cards.push(...ev.cards)
              break
            case 'upgrades': {
              // the upgrades tool and show_upgrades may both name a card
              const have = new Set(pending.upgrades.map((u) => u.key))
              pending.upgrades.push(...ev.upgrades.filter((u) => !have.has(u.key)))
              break
            }
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
      patchLast((tr) => ({
        ...tr,
        tool: undefined,
        proposals: pending.proposals.length ? [...(tr.proposals ?? []), ...pending.proposals] : tr.proposals,
        cards: pending.cards.length ? [...(tr.cards ?? []), ...pending.cards] : tr.cards,
        upgrades: pending.upgrades.length ? [...(tr.upgrades ?? []), ...pending.upgrades] : tr.upgrades,
      }))
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

  // every open proposal of one answer in one go, after one confirm that
  // lists the targets. Each goes through the same endpoint the dialog
  // uses, one after the other; a failure lands on its card, the rest go on.
  const createAll = async (ti: number) => {
    const open = (turns[ti]?.proposals ?? []).map((p, idx) => ({ p, idx })).filter(({ p }) => !p.done && !p.unverified)
    if (open.length < 2) return
    const lines = open.map(({ p }) => `${p.title} → ${targetOf(p)}`).join('\n')
    if (!(await confirm({ title: t('assistant.createAll', { count: open.length }), message: t('assistant.createAllConfirm', { count: open.length }) + '\n' + lines }))) return
    let ok = 0
    let failed = 0
    for (const { p, idx } of open) {
      let error = ''
      try {
        if (p.kind === 'watch') {
          await api.post('/api/watches', { serverId: p.serverId, ...p.fields })
        } else {
          const r = await api.post<SyncResult>('/api/downloads/sync', { serverId: p.serverId, ...p.fields })
          error = syncOutcome(r, t) ?? ''
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      if (error) failed++
      else ok++
      setTurns((prev) =>
        prev.map((tr, i) =>
          i === ti ? { ...tr, proposals: tr.proposals?.map((q, j) => (j === idx ? { ...q, done: !error, error: error || undefined } : q)) } : tr,
        ),
      )
    }
    qc.invalidateQueries({ queryKey: ['watches'] })
    qc.invalidateQueries({ queryKey: ['downloads'] })
    setNotice(t('assistant.createdCount', { ok, failed }))
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
  const defaultModel = models?.default ?? status?.model ?? ''

  // the page's secondary controls, in the app bar on a phone and in a row
  // under the header on desktop: the model menu only when there is a choice,
  // the clear button only once there is something to clear
  const actions = (
    <PageActions>
      <div className="flex items-center gap-2 lg:mb-4 lg:justify-end">
        {modelList.length > 1 && (
          <div className="relative" ref={modelRef}>
            <Button
              size="sm"
              aria-haspopup="listbox"
              aria-expanded={modelOpen}
              aria-label={t('assistant.model')}
              title={effectiveModel || defaultModel}
              onClick={() => setModelOpen((o) => !o)}
            >
              <Cpu aria-hidden size="1.2em" />
            </Button>
            {modelOpen && (
              <Menu className="absolute right-0 z-20 mt-1 max-w-72" aria-label={t('assistant.model')}>
                {['', ...modelList.filter((m) => m !== defaultModel)].map((m) => (
                  <MenuItem
                    key={m}
                    selected={effectiveModel === m}
                    trailing={<Check aria-hidden size="1.2em" className="shrink-0" />}
                    onClick={() => {
                      pickModel(m)
                      setModelOpen(false)
                    }}
                  >
                    <span className="truncate font-mono text-xs">{m || t('assistant.modelDefault', { model: defaultModel })}</span>
                  </MenuItem>
                ))}
              </Menu>
            )}
          </div>
        )}
        {!empty && (
          <Button size="sm" aria-label={t('assistant.clear')} title={t('assistant.clear')} onClick={clear}>
            <Trash2 aria-hidden size="1.2em" />
          </Button>
        )}
      </div>
    </PageActions>
  )

  // one layout for the empty and the running conversation, so the composer
  // never moves: header (desktop), the log, the composer as the last row
  return (
    <div className="page-fill flex min-h-0 w-full max-w-3xl flex-1 flex-col">
      {actions}

      <div ref={logRef} role="log" aria-live="polite" aria-label={t('assistant.title')} className="min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <div className="flex min-h-full flex-col justify-center">
            <p className="text-base text-t-secondary">{t('assistant.intro')}</p>
            <ul className="mt-4">
              {EXAMPLES.map((k) => (
                <li key={k}>
                  <button type="button" className={navItemClass('row', false)} onClick={() => void send(t(`assistant.examples.${k}`))}>
                    <Sparkles aria-hidden size="1em" className="shrink-0 text-accent" />
                    {t(`assistant.examples.${k}`)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ol className="space-y-5">
            {turns.map((tr, ti) => (
              <li key={ti} className={tr.role === 'user' ? 'ai-turn flex justify-end' : 'ai-turn'}>
                {tr.role === 'user' ? (
                  <p className="max-w-[85%] whitespace-pre-wrap wrap-break-word bg-bg-hover px-3 py-2 text-base">
                    <span className="sr-only">{t('assistant.you')}: </span>
                    {tr.content}
                  </p>
                ) : (
                  <div className="min-w-0 text-base leading-relaxed">
                    <span className="sr-only">{t('assistant.title')}: </span>
                    {tr.steps?.length ? (
                      <details
                        className="group mb-2"
                        open={tr.stepsOpen ?? false}
                        onToggle={(e) => {
                          const isOpen = (e.target as HTMLDetailsElement).open
                          setTurns((prev) =>
                            prev.map((x, i) => (i === ti && isOpen !== (x.stepsOpen ?? false) ? { ...x, stepsOpen: isOpen, stepsTouched: true } : x)),
                          )
                        }}
                      >
                        <summary className="inline-flex min-h-6 cursor-pointer items-center gap-1 text-xs text-t-muted">
                          <ChevronRight aria-hidden size="1em" className="transition-transform group-open:rotate-90" />
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
                    {!tr.content && !tr.tool && !tr.error && streaming && ti === last && (
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
                    {/* min-w-0 on the items: a grid item's automatic minimum is
                        its content's min-content width, and a truncated title
                        reports its full text there - the card grew past a phone's
                        viewport and the log scrolled sideways */}
                    {tr.cards?.length ? (
                      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                        {tr.cards.map((c) => (
                          <li key={`${c.source}:${c.media.id}`} className="min-w-0">
                            <MediaCard
                              className="h-full"
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
                          onSync={(r) => setUpSync({ ...r, initial: applyDefaults(r.initial, 'anime-series', defaults) })}
                          onDetails={setDetail}
                        />
                      </div>
                    ))}
                    {tr.proposals?.map((p, pi) => (
                      <ProposalCard key={pi} p={p} onOpen={() => setOpen({ turn: ti, idx: pi })} />
                    ))}
                    {(tr.proposals?.filter((p) => !p.done && !p.unverified).length ?? 0) >= 2 && (
                      <Button variant="primary" cut className="mt-3" onClick={() => void createAll(ti)}>
                        {t('assistant.createAll', { count: tr.proposals!.filter((p) => !p.done && !p.unverified).length })}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      {notice && (
        <Badge tone="ok" role="status" className="mt-2 self-start">
          {notice}
        </Badge>
      )}
      <form
        className="mt-3 flex items-end gap-2 border-t border-border-subtle pt-3"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <label className="flex min-w-0 flex-1">
          <span className="sr-only">{t('assistant.placeholder')}</span>
          <Textarea
            rows={2}
            className="w-full resize-none"
            placeholder={t('assistant.placeholder')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            // not on a phone: focusing on arrival raises the keyboard and
            // shrinks the whole shell before anything was read
            autoFocus={wide}
          />
        </label>
        {/* the button matches the two-row textarea: it stretches to the row,
            square, the height and padding utilities need the ! because .t-btn is unlayered */}
        {streaming ? (
          <Button type="button" className="aspect-square h-auto! self-stretch px-0!" aria-label={t('assistant.stop')} title={t('assistant.stop')} onClick={() => abortRef.current?.abort()}>
            <Square aria-hidden size="1.2em" />
          </Button>
        ) : (
          <Button type="submit" variant="primary" className="aspect-square h-auto! self-stretch px-0!" aria-label={t('assistant.send')} title={t('assistant.send')} disabled={!input.trim()}>
            <Send aria-hidden size="1.2em" />
          </Button>
        )}
      </form>

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

// targetOf is where a proposal lands: the target folder, plus the remote
// folder's name when the sync writes into a subfolder.
function targetOf(p: AiProposal): string {
  const f = p.fields
  const sub = f.subfolder ? '/' + (p.remotePath.split('/').filter(Boolean).pop() ?? '') : ''
  return (f.localPath || '?') + sub
}

function ProposalCard({ p, onOpen }: { p: AiProposal & { done?: boolean; error?: string }; onOpen: () => void }) {
  const { t } = useTranslation()
  return (
    <Panel className="mt-3 p-4 text-base">
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
      <p className="break-all font-mono text-sm text-t-muted">
        {t('assistant.target')}: {targetOf(p)}
        {p.fields.template && <span className="text-t-faint"> · {p.fields.template}</span>}
      </p>
      {p.error && (
        <p className="mt-2 text-sm text-err" role="alert">
          {p.error}
        </p>
      )}
      {p.info?.length ? (
        <ul className="mt-2 list-inside list-disc text-sm text-t-secondary">
          {p.info.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
      {!p.done && (
        <Button variant="primary" className="mt-3" onClick={onOpen}>
          {p.kind === 'watch' ? t('assistant.create') : t('assistant.queue')}
        </Button>
      )}
    </Panel>
  )
}
