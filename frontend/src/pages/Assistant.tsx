import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, ChevronRight, History, ImagePlus, Mic, Plus, RefreshCw, Send, Sparkles, Square, Trash2, X } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge, Button, Dialog, EmptyState, IconButton, MediaCard, Menu, MenuItem, Panel, navItemClass, useMediaQuery, useMenu } from '@weebsync/design-system'
import {
  api,
  mediaTitle,
  streamAiChat,
  syncOutcome,
  type AiCard, type AiChatSummary,
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
import Markdown from '../components/Markdown'
import { useAiModels, useAiStatus, useAuth } from '../hooks'
import PageActions, { WIDE_MQ } from '../components/PageActions'
import WatchDialog, { type WatchFields } from '../components/WatchDialog'
import { applyDefaults, useWatchDefaults } from '../components/watchDefaults'
import { useConfirm } from '../components/confirm'

// stripWrittenCall drops a tool call a small model wrote out instead of
// calling it, recommend(titles=[...]): the server turned that into cards
const stripWrittenCall = (s: string) => s.replace(/\b(?:recommend|show_upgrades|propose)\((?:[^()]|\([^()]*\))*\)/g, '').trim()

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
  /** data URLs of the pictures on a user turn */
  images?: string[]
  proposals?: (AiProposal & { done?: boolean; error?: string })[]
  cards?: AiCard[]
  /** titles the answer names, with their records: the names link into the catalog */
  links?: AiCard[]
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
  const { t, i18n } = useTranslation()
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
  // the saved chat this conversation belongs to; null until the first save
  const chatKey = `weebsync.ai.chat.${uid}`
  const [chatId, setChatId] = useState<number | null>(() => {
    try {
      const v = sessionStorage.getItem(chatKey)
      return v ? Number(v) : null
    } catch {
      return null
    }
  })
  const [attachments, setAttachments] = useState<string[]>([])
  const [histOpen, setHistOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // one line that grows with the text, up to a few lines, then scrolls
  const taRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
  }, [input])
  const { open: addOpen, setOpen: setAddOpen, ref: addRef } = useMenu()
  const dictation = useDictation(i18n.language)
  // follow-ups typed while an answer is still streaming: they wait here and
  // go out one by one once the stream ends, with the finished answer in
  // their history
  const [queue, setQueue] = useState<string[]>([])
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

  // the conversation is saved once a stream is over: a new chat gets its row,
  // a known one is replaced. Nothing is written while an answer streams.
  const savedRef = useRef('')
  useEffect(() => {
    try {
      if (chatId) sessionStorage.setItem(chatKey, String(chatId))
      else sessionStorage.removeItem(chatKey)
    } catch {
      /* best effort */
    }
  }, [chatId, chatKey])
  useEffect(() => {
    if (streaming || turns.length === 0) return
    const json = JSON.stringify(turns)
    if (json === savedRef.current) return
    const timer = setTimeout(async () => {
      savedRef.current = json
      const first = turns.find((tr) => tr.role === 'user')
      const title = (first?.content.trim() || t('assistant.untitled')).slice(0, 80)
      try {
        if (chatId) await api.put(`/api/ai/chats/${chatId}`, { title, turns })
        else {
          const { id } = await api.post<{ id: number }>('/api/ai/chats', { title, turns })
          setChatId(id)
        }
        qc.invalidateQueries({ queryKey: ['ai-chats'] })
      } catch {
        savedRef.current = '' // try again with the next change
      }
    }, 800)
    return () => clearTimeout(timer)
  }, [turns, streaming, chatId, qc, t])

  const newChat = () => {
    abortRef.current?.abort()
    setTurns([])
    setQueue([])
    setAttachments([])
    setChatId(null)
    savedRef.current = ''
    setNotice('')
  }
  const openChat = async (id: number) => {
    const c = await api.get<{ id: number; turns: Turn[] }>(`/api/ai/chats/${id}`)
    abortRef.current?.abort()
    setQueue([])
    setTurns(c.turns)
    savedRef.current = JSON.stringify(c.turns)
    setChatId(c.id)
    setHistOpen(false)
  }
  const deleteChat = async (id: number) => {
    if (!(await confirm({ message: t('assistant.deleteChatConfirm'), destructive: true }))) return
    await api.del(`/api/ai/chats/${id}`)
    qc.invalidateQueries({ queryKey: ['ai-chats'] })
    if (id === chatId) newChat()
  }

  const patchLast = (fn: (turn: Turn) => Turn) =>
    setTurns((prev) => prev.map((tr, i) => (i === prev.length - 1 ? fn(tr) : tr)))

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim()
    // pictures go with the message typed now; a follow-up during a stream
    // is text only, its pictures stay in the composer for the next turn
    const images = raw === undefined && !streaming ? attachments : []
    if (!text && images.length === 0) return
    if (streaming) {
      // queued here, and offered to the running answer: taken on, it comes
      // back as a steer event and leaves the queue; otherwise it goes out
      // as a turn of its own once the stream ends
      setQueue((q) => [...q, text])
      setInput('')
      api.post('/api/ai/steer', { text }).catch(() => {})
      return
    }
    const history: AiChatMessage[] = [...turns, { role: 'user' as const, content: text, images }]
      .filter((tr) => tr.content.trim() || tr.images?.length)
      .map((tr) => ({ role: tr.role, content: tr.content, images: tr.images?.length ? tr.images : undefined }))
    setInput('')
    if (images.length) setAttachments([])
    setTurns((prev) => [...prev, { role: 'user', content: text, images: images.length ? images : undefined }, { role: 'assistant', content: '' }])
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
            case 'links':
              patchLast((tr) => ({ ...tr, links: ev.cards }))
              break
            case 'upgrades': {
              // the upgrades tool and show_upgrades may both name a card
              const have = new Set(pending.upgrades.map((u) => u.key))
              pending.upgrades.push(...ev.upgrades.filter((u) => !have.has(u.key)))
              break
            }
            case 'steer':
              // the answer so far stays as it is; the follow-up becomes a
              // user turn and what the model says next lands after it
              setQueue((q) => {
                const i = q.indexOf(ev.text)
                return i < 0 ? q : q.filter((_, j) => j !== i)
              })
              setTurns((prev) => [
                ...prev.map((tr, i) => (i === prev.length - 1 ? { ...tr, tool: undefined, stepsOpen: tr.stepsTouched ? tr.stepsOpen : false } : tr)),
                { role: 'user', content: ev.text },
                { role: 'assistant', content: '' },
              ])
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

  // the next waiting follow-up goes out as soon as the stream is over; an
  // effect rather than a call from the stream's end, so it sees the turns
  // the stream left behind
  useEffect(() => {
    if (streaming || queue.length === 0) return
    const [next, ...rest] = queue
    setQueue(rest)
    void send(next)
  }, [streaming, queue])

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
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
  // whether the model in use reads pictures: true, false, or null when the
  // endpoint does not say - then attaching is allowed and the model's error
  // is the answer
  const modelInUse = effectiveModel || defaultModel
  const vision: boolean | null = models?.vision?.[modelInUse] ?? null
  const addImages = async (files: Iterable<File>) => {
    if (vision === false) return
    const next: string[] = []
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue
      try {
        next.push(await shrinkImage(f))
      } catch {
        /* unreadable picture: skipped */
      }
    }
    if (next.length) setAttachments((a) => [...a, ...next].slice(0, 4))
  }


  // the page's secondary controls, in the app bar on a phone and in a row
  // under the header on desktop: the model menu only when there is a choice,
  // the clear button only once there is something to clear
  const actions = (
    <PageActions>
      <div className="flex items-center gap-2 lg:mb-4 lg:justify-end">
        <Button size="sm" aria-label={t('assistant.history')} title={t('assistant.history')} onClick={() => setHistOpen(true)}>
          <History aria-hidden size="1.2em" />
        </Button>
        {!empty && (
          <Button size="sm" aria-label={t('assistant.clear')} title={t('assistant.clear')} onClick={newChat}>
            <Plus aria-hidden size="1.2em" />
          </Button>
        )}
      </div>
    </PageActions>
  )

  // one layout for the empty and the running conversation, so the composer
  // never moves: header (desktop), the log, the composer as the last row
  return (
    <div className="page-fill flex min-h-0 w-full flex-1 flex-col">
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
                  <div className="max-w-[85%] bg-bg-hover px-3 py-2 text-base">
                    <span className="sr-only">{t('assistant.you')}: </span>
                    {tr.images?.length ? (
                      <ul className="mb-2 flex flex-wrap gap-2">
                        {tr.images.map((src, i) => (
                          <li key={i}>
                            <img src={src} alt="" className="max-h-40 max-w-full border border-border-subtle" />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {tr.content && <p className="whitespace-pre-wrap wrap-break-word">{tr.content}</p>}
                  </div>
                ) : (
                  <div className="min-w-0 text-base leading-relaxed">
                    {/* the words in a bubble like the user's, so they read
                        against a plain ground and not the shell's hatching;
                        the cards stay outside, they are tiles of their own */}
                    <div className="max-w-[85%] bg-bg-hover px-3 py-2">
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
                      <Markdown
                        text={stripWrittenCall(tr.content)}
                        titles={(tr.links ?? []).flatMap((c) =>
                          [c.media.title.preferred, c.media.title.english, c.media.title.romaji]
                            .filter((x): x is string => !!x)
                            .map((title) => ({ title, onClick: () => setCard(c) })),
                        )}
                      >
                        {streaming && ti === last && !tr.tool && <span className="ai-cursor" aria-hidden />}
                      </Markdown>
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
                    </div>
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
        {queue.length > 0 && (
          <ol className="mt-5 space-y-3" aria-label={t('assistant.queued')}>
            {queue.map((q, i) => (
              <li key={`${i}-${q}`} className="ai-turn flex items-start justify-end gap-2">
                <p className="max-w-[85%] whitespace-pre-wrap wrap-break-word border border-dashed border-border-subtle px-3 py-2 text-base text-t-secondary">
                  <span className="sr-only">{t('assistant.you')}: </span>
                  {q}
                  <span className="mt-1 block text-xs text-t-muted">{t('assistant.queued')}</span>
                </p>
                <Button size="sm" aria-label={t('assistant.dequeue')} title={t('assistant.dequeue')} onClick={() => setQueue((qs) => qs.filter((_, j) => j !== i))}>
                  <X aria-hidden size="1em" />
                </Button>
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
      {/* the composer: one quiet box, the add menu, the text, the mic and the
          send arrow in a single row, the model as a line of small text below.
          Pictures land here by drop, paste, the menu or a phone's camera */}
      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
        onDragOver={(e) => {
          if (vision === false) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void addImages(e.dataTransfer.files)
        }}
      >
        <div className={`border bg-bg-card transition-colors ${dragging ? 'border-accent' : 'border-border-subtle focus-within:border-accent/60'}`}>
          {attachments.length > 0 && (
            <ul className="flex flex-wrap gap-1.5 px-3 pt-3">
              {attachments.map((src, i) => (
                <li key={i} className="relative">
                  <img src={src} alt="" className="h-14 w-14 border border-border-subtle object-cover" />
                  <button
                    type="button"
                    className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center border border-border-subtle bg-bg-card text-t-muted hover:text-err"
                    aria-label={t('assistant.removeImage')}
                    onClick={() => setAttachments((a) => a.filter((_, j) => j !== i))}
                  >
                    <X aria-hidden size="0.8em" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2 px-3 py-2">
            <div className="relative" ref={addRef}>
              <IconButton
                aria-label={t('assistant.add')}
                title={t('assistant.add')}
                aria-haspopup="menu"
                aria-expanded={addOpen}
                className="size-9! text-t-muted hover:text-accent"
                onClick={() => setAddOpen((o) => !o)}
              >
                <Plus aria-hidden size="1.4em" />
              </IconButton>
              {addOpen && (
                <Menu className="absolute bottom-full left-0 z-20 mb-1" aria-label={t('assistant.add')}>
                  <MenuItem
                    aria-disabled={vision === false}
                    title={vision === false ? t('assistant.attachNoVision') : undefined}
                    onClick={() => {
                      setAddOpen(false)
                      if (vision !== false) fileRef.current?.click()
                    }}
                  >
                    <ImagePlus aria-hidden size="1em" className={vision === false ? 'opacity-50' : ''} />
                    <span className={vision === false ? 'opacity-50' : ''}>{t('assistant.addPhoto')}</span>
                  </MenuItem>
                </Menu>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                tabIndex={-1}
                onChange={(e) => {
                  void addImages(e.target.files ?? [])
                  e.target.value = ''
                }}
              />
            </div>
            {dictation.active ? (
              <p className="flex min-h-9 min-w-0 flex-1 items-center gap-3 px-1 text-base" aria-live="polite">
                <span className={`min-w-0 flex-1 truncate ${dictation.text ? 'text-t-primary' : 'text-t-muted italic'}`}>{dictation.text || t('assistant.listening')}</span>
                <span className="ai-dots" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
              </p>
            ) : (
              <label className="flex min-w-0 flex-1">
                <span className="sr-only">{t('assistant.placeholder')}</span>
                <textarea
                  ref={taRef}
                  rows={1}
                  className="max-h-40 w-full resize-none bg-transparent px-1 py-1.5 text-base leading-6 text-t-primary outline-none placeholder:text-t-faint"
                  placeholder={streaming ? t('assistant.placeholderQueue') : t('assistant.placeholder')}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKey}
                  onPaste={(e) => {
                    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
                    if (files.length) {
                      e.preventDefault()
                      void addImages(files)
                    }
                  }}
                  // not on a phone: focusing on arrival raises the keyboard and
                  // shrinks the whole shell before anything was read
                  autoFocus={wide}
                />
              </label>
            )}
            {dictation.active ? (
              <>
                <IconButton aria-label={t('assistant.dictateCancel')} title={t('assistant.dictateCancel')} className="size-9! text-t-muted hover:text-err" onClick={dictation.cancel}>
                  <X aria-hidden size="1.3em" />
                </IconButton>
                <IconButton
                  aria-label={t('assistant.dictateDone')}
                  title={t('assistant.dictateDone')}
                  className="size-9! bg-accent text-bg-primary"
                  onClick={() => {
                    const said = dictation.accept()
                    if (said) setInput((v) => (v ? `${v} ${said}` : said))
                  }}
                >
                  <Check aria-hidden size="1.3em" />
                </IconButton>
              </>
            ) : (
              <>
                {dictation.supported && (
                  <IconButton aria-label={t('assistant.dictate')} title={t('assistant.dictate')} className="size-9! text-t-muted hover:text-accent" onClick={dictation.start}>
                    <Mic aria-hidden size="1.3em" />
                  </IconButton>
                )}
                {(input.trim() || attachments.length > 0) && (
                  <button type="submit" className="t-iconbtn size-9! bg-accent text-bg-primary" aria-label={t('assistant.send')} title={t('assistant.send')}>
                    <Send aria-hidden size="1.3em" />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        <div className="mt-1.5 flex min-h-6 items-center justify-end gap-4 px-1 text-xs text-t-muted">
          {streaming && (
            <button type="button" className="inline-flex min-h-6 items-center gap-1 hover:text-t-primary" onClick={() => abortRef.current?.abort()}>
              <Square aria-hidden size="0.9em" />
              {t('assistant.stop')}
            </button>
          )}
          {modelList.length > 1 && (
            <div className="relative" ref={modelRef}>
              <button
                type="button"
                className="inline-flex min-h-6 max-w-64 items-center gap-1 hover:text-t-primary"
                aria-haspopup="listbox"
                aria-expanded={modelOpen}
                aria-label={t('assistant.model')}
                title={modelInUse}
                onClick={() => setModelOpen((o) => !o)}
              >
                <span className="truncate">{modelInUse}</span>
                <ChevronDown aria-hidden size="0.9em" className="shrink-0" />
              </button>
              {modelOpen && (
                <Menu className="absolute right-0 bottom-full z-20 mb-1 max-w-72" aria-label={t('assistant.model')}>
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
        </div>
      </form>

      {histOpen && (
        <Dialog aria-label={t('assistant.history')} onClose={() => setHistOpen(false)}>
          <ChatHistory current={chatId} onOpen={(id) => void openChat(id)} onDelete={(id) => void deleteChat(id)} />
        </Dialog>
      )}
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

// ChatHistory lists the saved chats, newest change first: open one, or
// delete it. The one on screen is marked.
function ChatHistory({ current, onOpen, onDelete }: { current: number | null; onOpen: (id: number) => void; onDelete: (id: number) => void }) {
  const { t } = useTranslation()
  const { data: chats } = useQuery<AiChatSummary[]>({ queryKey: ['ai-chats'], queryFn: () => api.get('/api/ai/chats') })
  return (
    <div className="p-4">
      <h3 className="font-display font-semibold tracking-wider">{t('assistant.history')}</h3>
      {chats && chats.length === 0 && <p className="mt-3 text-sm text-t-muted">{t('assistant.historyEmpty')}</p>}
      <ul className="mt-3 max-h-[60vh] divide-y divide-border-subtle overflow-y-auto">
        {chats?.map((c) => (
          <li key={c.id} className="flex items-center gap-2 py-1">
            <button
              type="button"
              className={`flex min-w-0 flex-1 flex-col py-1.5 text-left ${c.id === current ? 'text-accent' : 'text-t-secondary hover:text-t-primary'}`}
              onClick={() => onOpen(c.id)}
            >
              <span className="truncate text-sm">{c.title || t('assistant.untitled')}</span>
              <span className="font-mono text-[11px] text-t-muted">{new Date(c.updatedAt.replace(' ', 'T') + 'Z').toLocaleString()}</span>
            </button>
            <Button size="sm" aria-label={t('assistant.deleteChat')} title={t('assistant.deleteChat')} onClick={() => onDelete(c.id)}>
              <Trash2 aria-hidden size="1em" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// shrinkImage scales a picture to at most 1280px on its long side and
// returns it as a JPEG data URL: what a vision model needs, and small enough
// to travel in the history with every later message.
async function shrinkImage(file: File): Promise<string> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  bmp.close()
  return canvas.toDataURL('image/jpeg', 0.85)
}

// useDictation wraps the browser's speech recognition (Chrome, Edge, Safari;
// Firefox has none, then the mic stays hidden). Words arrive as they are
// spoken; accept hands them over, cancel drops them.
// ponytail: the browser's own recognition, a transcription model behind
// the endpoint if a browser without it matters
interface Recognizer {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
function useDictation(lang: string) {
  const Ctor = (window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: new () => Recognizer }).webkitSpeechRecognition
  const [active, setActive] = useState(false)
  const [text, setText] = useState('')
  const rec = useRef<Recognizer | null>(null)
  const final = useRef('')
  useEffect(() => () => rec.current?.abort(), [])
  const stop = () => {
    rec.current?.abort()
    rec.current = null
    setActive(false)
  }
  return {
    supported: !!Ctor,
    active,
    text,
    start: () => {
      if (!Ctor) return
      const r = new Ctor()
      r.lang = lang.startsWith('de') ? 'de-DE' : 'en-US'
      r.continuous = true
      r.interimResults = true
      final.current = ''
      setText('')
      r.onresult = (e) => {
        let interim = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i]
          if (res.isFinal) final.current += res[0].transcript
          else interim += res[0].transcript
        }
        setText((final.current + interim).trim())
      }
      // the browser ends a session on its own after a silence: what was
      // said stays on screen until it is accepted or dropped
      r.onend = () => {
        rec.current = null
      }
      r.onerror = () => {
        rec.current = null
      }
      rec.current = r
      setActive(true)
      r.start()
    },
    accept: () => {
      const said = text
      stop()
      setText('')
      return said
    },
    cancel: () => {
      stop()
      setText('')
    },
  }
}
