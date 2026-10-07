import { Trash2 } from 'lucide-react'
import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, Input } from '@weebsync/design-system'
import { api } from '../api'
import { Hint } from './RenameOptions'

export interface PlexShowRef {
  ratingKey: string
  title: string
  year: number
  library: string
}

export interface PlexShowState {
  show?: PlexShowRef
  /** which route resolved it: manual | series | path | title | none */
  source: string
  candidates: PlexShowRef[]
}

/** usePlexShow reads which Plex show a watch resolves to; the field reuses the
 *  same query, so offering the library costs nothing extra. */
export function usePlexShow(watchId?: number) {
  return useQuery<PlexShowState>({
    queryKey: ['plex-show', watchId],
    queryFn: () => api.get(`/api/watches/${watchId}/plex-show`),
    enabled: !!watchId,
    retry: false, // Plex may not be configured at all; one 503 is answer enough
    staleTime: 60_000,
  })
}

/**
 * PlexShowField binds the watch's SERIES to a Plex show by hand, as a combobox
 * inside the watch form rather than a dialog on top of it. The choice outranks
 * every automatic lookup and applies to every watch of that series (the hint
 * says so), which is also why a pick is stored at once and not with the form:
 * it is not a field of this watch.
 */
export default function PlexShowField({
  watchId,
  state,
  onDone,
}: {
  watchId: number
  state: PlexShowState
  onDone: () => void
}) {
  const { t } = useTranslation()
  const ids = useId()
  const listId = `${ids}-list`
  // null = not searching: the field shows the bound show
  const [q, setQ] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Filtering happens here, per keystroke: the whole library came with the
  // query, so there is no request to debounce.
  const shown = useMemo(() => {
    const needle = (q ?? '').trim().toLowerCase()
    const all = state.candidates
    return needle ? all.filter((c) => c.title.toLowerCase().includes(needle)) : all
  }, [q, state.candidates])

  const reset = () => {
    setOpen(false)
    setActive(-1)
    setQ(null)
  }
  const pick = async (ratingKey: string) => {
    setError('')
    setBusy(true)
    try {
      await api.put(`/api/watches/${watchId}/plex-show`, { ratingKey })
      reset()
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('app.error'))
    } finally {
      setBusy(false)
    }
  }
  const move = (to: number) => {
    setOpen(true)
    setActive(to)
    // the active option is only announced, not focused: keep it in view
    document.getElementById(`${listId}-${to}`)?.scrollIntoView?.({ block: 'nearest' })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = shown.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (n) move(!open ? 0 : (active + 1) % n)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (n) move(!open || active <= 0 ? n - 1 : active - 1)
    } else if (e.key === 'Enter') {
      // inside the watch form Enter would submit it: here it picks instead
      if (!open) return
      e.preventDefault()
      if (active >= 0 && shown[active] && !busy) void pick(shown[active].ratingKey)
    } else if (e.key === 'Escape') {
      // the list owns Escape while it is open or a search is typed: it closes
      // and the dialog around it stays, native cancel included
      if (!open && q === null) return
      e.preventDefault()
      e.stopPropagation()
      reset()
    }
  }

  const showMeta = (c: PlexShowRef) => [c.year || null, c.library].filter(Boolean).join(' · ')
  return (
    <div className="space-y-1">
      <label className="flex w-fit items-center text-xs text-t-muted" htmlFor={`${ids}-input`}>
        {t('watch.plexShow')}
        <Hint text={t('watch.plexShowScope')} />
      </label>
      <div className="flex items-stretch gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            id={`${ids}-input`}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
            aria-describedby={`${ids}-source`}
            className="w-full"
            autoComplete="off"
            spellCheck={false}
            value={q ?? state.show?.title ?? ''}
            placeholder={state.show ? t('watch.plexShowSearch') : t('watch.plexShowUnresolved')}
            onChange={(e) => {
              setQ(e.target.value)
              setOpen(true)
              setActive(-1)
            }}
            onClick={() => setOpen(!open)}
            onBlur={reset}
            onKeyDown={onKeyDown}
          />
          <ul
            id={listId}
            role="listbox"
            aria-label={t('watch.plexShowSearch')}
            hidden={!open}
            className="t-pop absolute right-0 left-0 z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border-subtle bg-bg-card py-1 shadow-lg"
          >
            {shown.map((c, i) => (
              <li
                key={c.ratingKey}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`min-h-6 cursor-pointer px-3 py-1.5 ${i === active ? 'bg-bg-secondary text-accent' : 'hover:bg-bg-secondary'}`}
                // mousedown, not click: it lands before the input's blur
                // would close the list under the pointer
                onMouseDown={(e) => {
                  e.preventDefault()
                  if (!busy) void pick(c.ratingKey)
                }}
              >
                <span className="block truncate text-sm">{c.title}</span>
                <span className="text-xs text-t-muted">{showMeta(c)}</span>
              </li>
            ))}
            {shown.length === 0 && (
              <li role="option" aria-selected={false} aria-disabled className="px-3 py-1.5 text-sm text-t-muted">
                {t('watch.plexShowNone')}
              </li>
            )}
          </ul>
        </div>
        {state.show && (
          <Button size="sm" className="shrink-0" disabled={busy} onClick={() => void pick('')}>
            <Trash2 aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('watch.plexShowClear')}
          </Button>
        )}
      </div>
      <p id={`${ids}-source`} className="text-xs text-t-muted">
        {t(`watch.plexShowSource.${state.source}`)}
      </p>
      {error && (
        <p className="text-xs text-err" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
