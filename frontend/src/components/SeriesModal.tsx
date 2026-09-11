import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Button, Dialog } from '@weebsync/design-system'
import { mediaTitle, type Media } from '../api'
import MediaDetail from './MediaDetail'

/** What a caller hands the title card: which title, and what it already knows. */
export interface SeriesTarget {
  /** anilist (default) | tmdb:tv | tmdb:movie */
  source?: string
  id: number
  /** the record the caller holds; the card fetches nothing it already has */
  media?: Media
  /** the watch the caller came from, listed first among the title's watches */
  watchId?: number
  /** the heading, where the caller knows a better one than the record's */
  title?: string
  /** caller-specific rows under the record, e.g. the catalog's folder versions */
  extra?: ReactNode
}

interface SeriesModalApi {
  open: (target: SeriesTarget) => void
  close: () => void
}

const Ctx = createContext<SeriesModalApi | null>(null)

/** The one way to open the title card, from any cover in the app. */
export function useSeriesModal(): SeriesModalApi {
  const api = useContext(Ctx)
  if (!api) throw new Error('useSeriesModal outside SeriesModalProvider')
  return api
}

/**
 * Holds the title card the whole app shares. One dialog instead of one per
 * page: a cover opens the same thing everywhere, and the card can grow tabs
 * without every caller learning about them. A route change closes it - the
 * catalog's rows navigate, and a card left open over another page would be a
 * door into the wrong room.
 */
export function SeriesModalProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<SeriesTarget | null>(null)
  const { pathname } = useLocation()
  useEffect(() => setTarget(null), [pathname])
  const open = useCallback((t: SeriesTarget) => setTarget({ ...t, source: t.source || 'anilist' }), [])
  const close = useCallback(() => setTarget(null), [])
  const api = useMemo(() => ({ open, close }), [open, close])
  return (
    <Ctx.Provider value={api}>
      {children}
      {target && <SeriesDialog target={target} onClose={close} />}
    </Ctx.Provider>
  )
}

function SeriesDialog({ target, onClose }: { target: SeriesTarget; onClose: () => void }) {
  const { t } = useTranslation()
  const media = target.media
  const name = target.title || (media ? mediaTitle(media) : '')
  return (
    <Dialog width="max-w-3xl" aria-label={t('remote.detailsFor', { name })} onClose={onClose}>
      <div className="dialog-body">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {media && (
            <MediaDetail media={media} source={target.source}>
              {target.extra}
            </MediaDetail>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <Button size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
        </footer>
      </div>
    </Dialog>
  )
}
