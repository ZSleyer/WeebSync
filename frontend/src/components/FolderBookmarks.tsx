import { Bookmark as BookmarkIcon, BookmarkCheck, BookmarkPlus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconButton, Menu, useMenu } from 'fluid-lycoris'
import type { ServerInfo } from '../api'
import { hasBookmark, type Bookmark, type useBookmarks } from './bookmarks'

// the last two segments say where a deep folder is; the full path is the title
const tail = (p: string) => p.split('/').filter(Boolean).slice(-2).join('/')

// one store for toggle and menu: the list lives in state, so two separate
// useBookmarks() calls would not see each other's changes
type Store = ReturnType<typeof useBookmarks>

/**
 * Bookmarks the folder in view. It acts on the address, so it sits with the
 * path (like a browser's star in the address bar), not with the menu of saved
 * folders.
 */
export function BookmarkToggle({ here, store }: { here: Bookmark; store: Store }) {
  const { t } = useTranslation()
  const saved = hasBookmark(store.list, here)
  const label = saved ? t('files.bookmarkRemove') : t('files.bookmarkAdd')
  return (
    <IconButton size="sm" aria-label={label} title={label} aria-pressed={saved} onClick={() => store.toggle(here)}>
      {saved ? <BookmarkCheck aria-hidden size="1.2em" /> : <BookmarkPlus aria-hidden size="1.2em" />}
    </IconButton>
  )
}

/**
 * Saved folders of the Files page: a menu that jumps to any saved one, across
 * all sources. Kept in this browser only (localStorage), not on the server.
 */
export default function FolderBookmarks({
  servers,
  onOpen,
  store,
}: {
  servers: ServerInfo[]
  onOpen: (b: Bookmark) => void
  store: Store
}) {
  const { t } = useTranslation()
  const { list, remove } = store
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
  // a bookmark of a deleted server has nowhere to go
  const shown = list.flatMap((b) => {
    if (b.source === 'local') return [{ b, name: t('files.local') }]
    const s = servers.find((x) => x.id === b.source)
    return s ? [{ b, name: s.name }] : []
  })
  const menuLabel = t('files.bookmarks')
  return (
    <div className="flex shrink-0 items-center">
      <div className="relative" ref={ref} style={anchorStyle}>
        <IconButton
          size="sm"
          aria-label={menuLabel}
          title={menuLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <BookmarkIcon aria-hidden size="1.2em" />
        </IconButton>
        {open && (
          <Menu kind="menu" anchor={anchor} placement="bottom-end" aria-label={menuLabel}>
            {shown.length === 0 && (
              <li role="none" className="px-3 py-2 text-sm text-t-muted">
                {t('files.bookmarksEmpty')}
              </li>
            )}
            {shown.map(({ b, name }) => (
              <li role="none" key={`${b.source}:${b.path}`} className="flex items-center">
                <button
                  type="button"
                  role="menuitem"
                  title={`${name}: /${b.path}`}
                  className="flex min-h-(--ctl-h) min-w-0 flex-1 flex-col justify-center rounded-[7px] px-3 py-1 text-left text-sm text-t-secondary hover:bg-bg-hover focus-visible:bg-bg-hover"
                  onClick={() => {
                    setOpen(false)
                    onOpen(b)
                  }}
                >
                  <span className="truncate">{tail(b.path) || t('files.rootFolder')}</span>
                  <span className="truncate text-xs text-t-muted">{name}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-label={t('files.bookmarkDelete', { path: `${name} /${b.path}` })}
                  title={t('files.bookmarkRemove')}
                  className="grid min-h-(--ctl-h) min-w-(--ctl-h) shrink-0 place-items-center rounded-[7px] text-t-muted hover:bg-bg-hover hover:text-t-primary focus-visible:bg-bg-hover"
                  onClick={(e) => {
                    // the row about to go holds focus: hand it to the next row's
                    // open button, else the previous one, else back to the trigger
                    const row = e.currentTarget.closest('li')
                    const next = (row?.nextElementSibling ?? row?.previousElementSibling)?.querySelector('button')
                    if (next) next.focus()
                    else {
                      setOpen(false)
                      ref.current?.querySelector<HTMLElement>('[aria-expanded]')?.focus()
                    }
                    remove(b)
                  }}
                >
                  <X aria-hidden size="1em" />
                </button>
              </li>
            ))}
          </Menu>
        )}
      </div>
    </div>
  )
}
