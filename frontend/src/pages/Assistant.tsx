import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Bot, Check, RefreshCw, Send, Square, Trash2, User as UserIcon } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge, Button, EmptyState, Panel, Textarea } from '@weebsync/design-system'
import { api, streamAiChat, syncOutcome, type AiChatMessage, type AiProposal, type SyncResult } from '../api'
import { useAiStatus, useAuth } from '../hooks'
import WatchDialog, { type WatchFields } from '../components/WatchDialog'

// One turn of the conversation as rendered. Proposals hang off the assistant
// turn that produced them; `done` marks a card the user already confirmed.
interface Turn {
  role: 'user' | 'assistant'
  content: string
  proposals?: (AiProposal & { done?: boolean })[]
  tool?: string // the tool currently running, while streaming
  error?: string
}

// The assistant chats over the user's own data and can only propose: every
// card opens the ordinary watch dialog, and what the dialog saves goes
// through the same endpoints the Suggestions page uses. The conversation
// lives in sessionStorage per user: gone with the tab, never in the DB.
export default function Assistant() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: user } = useAuth()
  const { data: status } = useAiStatus()
  const storageKey = `weebsync.ai.${user?.id ?? 0}`
  const [turns, setTurns] = useState<Turn[]>(() => {
    try {
      const v = sessionStorage.getItem(`weebsync.ai.${user?.id ?? 0}`)
      return v ? (JSON.parse(v) as Turn[]) : []
    } catch {
      return []
    }
  })
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [notice, setNotice] = useState('')
  const [open, setOpen] = useState<{ turn: number; idx: number } | null>(null)
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

  const patchLast = (fn: (turn: Turn) => Turn) =>
    setTurns((prev) => prev.map((tr, i) => (i === prev.length - 1 ? fn(tr) : tr)))

  const send = async () => {
    const text = input.trim()
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
            case 'tool':
              patchLast((tr) => ({ ...tr, tool: ev.name }))
              break
            case 'proposal': {
              const { type: _t, ...p } = ev
              patchLast((tr) => ({ ...tr, proposals: [...(tr.proposals ?? []), p] }))
              break
            }
            case 'error':
              patchLast((tr) => ({ ...tr, error: ev.message, tool: undefined }))
              break
            case 'done':
              patchLast((tr) => ({ ...tr, tool: undefined }))
              break
          }
        },
        ac.signal,
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

  return (
    <div className="page-fill mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone="accent">{t('assistant.title')}</Badge>
        {status?.model && <span className="font-mono text-xs text-t-muted">{status.model}</span>}
        {notice && (
          <Badge tone="ok" role="status">
            {notice}
          </Badge>
        )}
        <Button size="sm" className="ml-auto" onClick={clear} disabled={!turns.length && !streaming}>
          <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
          {t('assistant.clear')}
        </Button>
      </div>

      <div ref={logRef} role="log" aria-live="polite" aria-label={t('assistant.title')} className="min-h-0 flex-1 overflow-y-auto pr-1">
        {!turns.length && <p className="p-4 text-sm text-t-muted">{t('assistant.intro')}</p>}
        <ol className="space-y-3">
          {turns.map((tr, ti) => (
            <li key={ti} className={`flex gap-2 ${tr.role === 'user' ? 'justify-end' : ''}`}>
              {tr.role === 'assistant' && <Bot aria-hidden size="1.25em" className="mt-2 shrink-0 text-accent" />}
              <div className={`min-w-0 max-w-[85%] ${tr.role === 'user' ? 'order-first' : ''}`}>
                <Panel className={`p-3 text-sm ${tr.role === 'user' ? 'bg-bg-hover' : ''}`}>
                  <span className="sr-only">{tr.role === 'user' ? t('assistant.you') : t('assistant.title')}: </span>
                  {tr.content && <p className="whitespace-pre-wrap break-words">{tr.content}</p>}
                  {tr.tool && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-t-muted">
                      <RefreshCw aria-hidden size="1em" className="animate-spin motion-reduce:animate-none" />
                      {t('assistant.toolRunning', { name: t(`assistant.tools.${tr.tool}`, { defaultValue: tr.tool }) })}
                    </p>
                  )}
                  {!tr.content && !tr.tool && tr.role === 'assistant' && !tr.error && streaming && ti === turns.length - 1 && (
                    <p className="text-xs text-t-muted">{t('assistant.thinking')}</p>
                  )}
                  {tr.error && (
                    <p className="mt-1 text-xs text-err" role="alert">
                      {t('assistant.error')}: {tr.error}
                    </p>
                  )}
                </Panel>
                {tr.proposals?.map((p, pi) => (
                  <ProposalCard key={pi} p={p} onOpen={() => setOpen({ turn: ti, idx: pi })} />
                ))}
              </div>
              {tr.role === 'user' && <UserIcon aria-hidden size="1.25em" className="mt-2 shrink-0 text-t-muted" />}
            </li>
          ))}
        </ol>
      </div>

      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <label className="flex-1 text-xs text-t-muted">
          <span className="sr-only">{t('assistant.placeholder')}</span>
          <Textarea
            rows={2}
            className="w-full resize-none"
            placeholder={t('assistant.placeholder')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
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

function ProposalCard({ p, onOpen }: { p: AiProposal & { done?: boolean }; onOpen: () => void }) {
  const { t } = useTranslation()
  return (
    <Panel className="mt-2 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{t(`assistant.kind.${p.kind}`)}</Badge>
        <span className="font-display font-semibold">{p.title}</span>
        {p.unverified && <Badge tone="warn">{t('assistant.unverified')}</Badge>}
        {p.done && (
          <Badge tone="ok">
            <Check aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('assistant.done')}
          </Badge>
        )}
      </div>
      <p className="mt-1 break-all font-mono text-xs text-t-muted">
        {p.serverName}: {p.remotePath}
      </p>
      {p.info?.length ? (
        <ul className="mt-1 list-inside list-disc text-xs text-t-secondary">
          {p.info.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
      {!p.done && (
        <Button size="sm" variant="primary" className="mt-2" onClick={onOpen}>
          {p.kind === 'watch' ? t('assistant.create') : t('assistant.queue')}
        </Button>
      )}
    </Panel>
  )
}
