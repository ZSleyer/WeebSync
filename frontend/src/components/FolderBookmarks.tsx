import { Bookmark as BookmarkIcon, BookmarkCheck, BookmarkPlus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconButton, Menu, useMenu } from 'fluid-lycoris'
import type { ServerInfo } from '../api'
import { hasBookmark, useBookmarks, type Bookmark } from './bookmarks'

// the last two segments say where a deep folder is; the full path is the title
const tail = (p: string) => p.split('/').filter(Boolean).slice(-2).join('/')

/**
 * Saved folders of the Files page: a button that bookmarks the folder in view
 * and a menu that jumps to any saved one, across all sources. Kept in this
 * browser only (localStorage), not on the server.
 */
export default function FolderBookmarks({
  here,
  servers,
  onOpen,
}: {
  here: Bookmark
  servers: ServerInfo[]
  onOpen: (b: Bookmark) => void
}) {
  const { t } = useTranslation()
  const { list, toggle, remove } = useBookmarks()
  const { open, setOpen, ref, anchor, anchorStyle } = useMenu()
  const saved = hasBookmark(list, here)
  // a bookmark of a deleted server has nowhere to go
  const shown = list.flatMap((b) => {
    if (b.source === 'local') return [{ b, name: t('files.local') }]
    const s = servers.find((x) => x.id === b.source)
    return s ? [{ b, name: s.name }] : []
  })
  const toggleLabel = saved ? t('files.bookmarkRemove') : t('files.bookmarkAdd')
  const menuLabel = t('files.bookmarks')
  return (
    <div className="flex shrink-0 items-center">
      <IconButton
        size="sm"
        aria-label={toggleLabel}
        title={toggleLabel}
        aria-pressed={saved}
        onClick={() => toggle(here)}
      >
        {saved ? <BookmarkCheck aria-hidden size="1.2em" /> : <BookmarkPlus aria-hidden size="1.2em" />}
      </IconButton>
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
