import { useId, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Input } from '@weebsync/design-system'
import { api, type Entry } from '../api'

// Split a root-relative partial path into its parent dir and the last segment,
// then return the full paths of child dirs whose name prefix-matches (case-
// insensitive). Used to autocomplete a typed path from an existing listing.
export function suggestDirs(partial: string, entries: Entry[]): string[] {
  const slash = partial.lastIndexOf('/')
  const parent = slash >= 0 ? partial.slice(0, slash) : ''
  const prefix = (slash >= 0 ? partial.slice(slash + 1) : partial).toLowerCase()
  return entries
    .filter((e) => e.isDir && e.name.toLowerCase().startsWith(prefix))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => (parent ? `${parent}/` : '') + e.name)
}

const parentOf = (p: string) => {
  const s = p.lastIndexOf('/')
  return s >= 0 ? p.slice(0, s) : ''
}

// WCAG 2.2 combobox for typing a directory path with autocomplete. Suggestions
// come from listing the parent dir via the same fetchPath/queryKey a FileBrowser
// uses, so a listing already fetched is served from cache (no extra request, no
// debounce needed - filtering is client-side per keystroke). Works root-relative;
// callers strip/add a leading slash at the boundary if they store absolute paths.
export default function PathInput({
  value,
  onChange,
  onCommit,
  onCancel,
  fetchPath,
  queryKey,
  id,
  ariaLabel,
  placeholder,
  autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  onCommit: (path: string) => void
  onCancel?: () => void
  fetchPath: (path: string) => string
  queryKey: unknown[]
  id?: string
  ariaLabel?: string
  placeholder?: string
  autoFocus?: boolean
}) {
  const { t } = useTranslation()
  const genId = useId()
  const listId = `${genId}-list`
  const inputId = id ?? `${genId}-input`
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const boxRef = useRef<HTMLDivElement>(null)

  const parent = parentOf(value)
  const { data: entries = [] } = useQuery<Entry[]>({
    queryKey: [...queryKey, parent],
    queryFn: () => api.get(fetchPath(parent)),
    enabled: open,
  })
  const options = suggestDirs(value, entries)
  // hide a single exact-match suggestion (nothing left to complete)
  const showList = open && options.length > 0 && !(options.length === 1 && options[0] === value)

  const commit = (p: string) => {
    setOpen(false)
    setActive(-1)
    onCommit(p.replace(/\/+$/, ''))
  }
  const pick = (p: string) => {
    // append a slash so the next keystroke-free suggestion lists the picked
    // dir's children; the user can descend without typing separators
    onChange(`${p}/`)
    setOpen(true)
    setActive(-1)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      if (showList) setActive((a) => (a + 1) % options.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (showList) setActive((a) => (a <= 0 ? options.length - 1 : a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (showList && active >= 0) pick(options[active])
      else commit(value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (showList) setOpen(false)
      else onCancel?.()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div ref={boxRef} className="relative min-w-0 flex-1">
      <Input
        id={inputId}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        className="w-full py-1 font-mono text-xs"
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // allow an option click to land before closing
          setTimeout(() => setOpen(false), 120)
        }}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label={ariaLabel ?? t('remote.path')}
          className="absolute left-0 right-0 z-20 mt-1 max-h-56 overflow-y-auto border border-border-subtle bg-bg-card py-1 shadow-lg"
        >
          {options.map((p, i) => (
            <li key={p}>
              <button
                type="button"
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`flex w-full items-center px-3 py-1.5 text-left font-mono text-xs hover:bg-bg-secondary ${
                  i === active ? 'bg-bg-secondary text-accent' : 'text-t-secondary'
                }`}
                // onMouseDown so it fires before the input's blur
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(p)
                }}
              >
                {p}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
