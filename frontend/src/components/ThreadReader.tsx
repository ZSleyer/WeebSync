import { useId, useState, type ReactNode } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ExternalLink, Heart, X } from 'lucide-react'
import {
  Badge,
  Button,
  Dialog,
  IconButton,
  SectionHeading,
  SHEET_MQ,
  Skeleton,
  TextLink,
  useMediaQuery,
} from 'fluid-lycoris'
import { api } from '../api'
import type { Schemas } from '../api.gen'
import { parseThreadText, relTime, type Inline, type ShortTitle } from './threadText'
import './thread.css'

type ThreadPage = Schemas['anilist.ThreadPage']
type Comment = Schemas['anilist.ThreadComment']

/** A shortened thread title as one line: the episode, then the rest after it. */
export function threadLabel(s: ShortTitle, full: string, t: TFunction): string {
  const ep = s.episode !== undefined ? t('thread.episode', { n: s.episode }) : ''
  return [ep, s.rest].filter(Boolean).join(' · ') || full
}

/**
 * One AniList forum thread, read in the app: the opening post, then the
 * comments page by page, replies one level in. A bottom sheet on a phone, a
 * dialog on a wide screen. Everything is text: AniList's markdown goes
 * through parseThreadText, never into the DOM as HTML.
 */
export function ThreadReader({
  id,
  title,
  short,
  url,
  onClose,
}: {
  id: number
  title: string
  short: ShortTitle
  url: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const titleId = useId()
  // one clock per opening: relative times stay put while the sheet is read
  const [now] = useState(() => Date.now())
  const q = useInfiniteQuery({
    queryKey: ['anilist-thread', id],
    queryFn: ({ pageParam }) => api.get<ThreadPage>(`/api/anilist/threads/${id}?page=${pageParam}`),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.hasNextPage ? all.length + 1 : undefined),
    staleTime: 5 * 60_000,
    retry: 1,
  })
  const first = q.data?.pages[0]?.thread
  const comments = q.data?.pages.flatMap((p) => p.comments) ?? []
  const label = threadLabel(short, title, t)
  // the sheet brings its own close (the grabber), the centred dialog needs one
  const sheet = useMediaQuery(SHEET_MQ)
  return (
    <Dialog
      onClose={onClose}
      sheet
      width="max-w-2xl"
      aria-labelledby={titleId}
      closeLabel={t('common.close')}
      bodyClassName="dialog-body"
    >
      <header className="ws-th-head">
        <div className="ws-th-top">
          <h3 id={titleId} className="font-display font-semibold tracking-wider">
            {label}
            {label !== title && <span className="sr-only">, {title}</span>}
          </h3>
          {!sheet && (
            <IconButton aria-label={t('common.close')} onClick={onClose}>
              <X aria-hidden />
            </IconButton>
          )}
        </div>
        <div className="ws-th-meta">
          {short.spoiler && (
            <Badge size="sm" tone="warn">
              {t('thread.spoiler')}
            </Badge>
          )}
          {first && (
            <span>
              {[t('series.replies', { count: first.replies }), t('series.views', { count: first.views })].join(' · ')}
            </span>
          )}
          <TextLink tone="accent-2" href={first?.url || url} target="_blank" rel="noopener noreferrer">
            {t('thread.open')}
            <ExternalLink aria-hidden size="0.875rem" />
            <span className="sr-only">({t('thread.newTab')})</span>
          </TextLink>
        </div>
      </header>
      <div className="ws-th-body">
        {q.isPending ? (
          <div role="status" aria-label={t('app.loading')} className="grid gap-3">
            <Skeleton className="w-1/3" />
            <Skeleton />
            <Skeleton />
            <Skeleton className="w-2/3" />
          </div>
        ) : q.isError && !q.data ? (
          <p className="ws-d-err" role="alert">
            {t('thread.failed')}{' '}
            <TextLink tone="accent-2" onClick={() => void q.refetch()}>
              {t('thread.retry')}
            </TextLink>
          </p>
        ) : (
          first && (
            <>
              <article className="ws-th-post" aria-label={t('thread.by', { name: first.user.name })}>
                <Byline user={first.user} at={first.createdAt} now={now} />
                <Body text={first.body} />
              </article>
              <SectionHeading
                level={3}
                tone="accent-2"
                title={t('thread.comments')}
                action={<span className="ws-d-count">{first.replies}</span>}
              />
              {comments.length === 0 ? (
                <p className="ws-d-quiet">{t('thread.noComments')}</p>
              ) : (
                <ul className="ws-th-list">
                  {comments.map((c) => (
                    <li key={c.id}>
                      <CommentView c={c} now={now} />
                      {c.replies.length > 0 && (
                        <ul className="ws-th-replies" aria-label={t('thread.replies', { name: c.user.name })}>
                          {c.replies.map((r) => (
                            <li key={r.id}>
                              <CommentView c={r} now={now} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {q.isFetchNextPageError && (
                <p className="ws-d-err" role="alert">
                  {t('thread.failed')}
                </p>
              )}
              {q.hasNextPage && (
                <Button
                  size="sm"
                  className="ws-th-more"
                  disabled={q.isFetchingNextPage}
                  aria-busy={q.isFetchingNextPage || undefined}
                  onClick={() => void q.fetchNextPage()}
                >
                  {q.isFetchingNextPage ? t('app.loading') : t('thread.more')}
                </Button>
              )}
            </>
          )
        )}
      </div>
    </Dialog>
  )
}

function Byline({ user, at, now }: { user: Comment['user']; at: number; now: number }) {
  const { i18n } = useTranslation()
  const when = at ? new Date(at * 1000) : null
  return (
    <div className="ws-th-by">
      {user.avatar ? (
        <img src={user.avatar} alt="" width={28} height={28} loading="lazy" decoding="async" />
      ) : (
        <span aria-hidden className="ws-th-noav" />
      )}
      <strong>{user.name}</strong>
      {when && (
        <time dateTime={when.toISOString()} title={when.toLocaleString(i18n.language)}>
          {relTime(at, now, i18n.language)}
        </time>
      )}
    </div>
  )
}

function CommentView({ c, now }: { c: Comment; now: number }) {
  const { t } = useTranslation()
  return (
    <article className="ws-th-c">
      <Byline user={c.user} at={c.createdAt} now={now} />
      <div className="ws-th-text">
        {c.replyTo && <span className="ws-th-to">@{c.replyTo} </span>}
        <Body text={c.body} />
      </div>
      {c.likes > 0 && (
        <span className="ws-th-likes">
          <Heart aria-hidden size="0.8125rem" />
          <span aria-hidden>{c.likes}</span>
          <span className="sr-only">{t('thread.likes', { count: c.likes })}</span>
        </span>
      )}
    </article>
  )
}

function Body({ text }: { text: string }) {
  return (
    <>
      {parseThreadText(text).map((p, i) => (
        <p key={i}>{p.map(inline)}</p>
      ))}
    </>
  )
}

function inline(tok: Inline, i: number): ReactNode {
  switch (tok.kind) {
    case 'text':
      return tok.text
    case 'br':
      return <br key={i} />
    case 'link':
      return (
        <a key={i} className="ws-th-a" href={tok.href} target="_blank" rel="noopener noreferrer">
          {tok.text}
        </a>
      )
    case 'media':
      return <MediaLink key={i} href={tok.href} media={tok.media} />
    case 'spoiler':
      return <Spoiler key={i}>{tok.children.map(inline)}</Spoiler>
  }
}

function MediaLink({ href, media }: { href: string; media: 'image' | 'video' }) {
  const { t } = useTranslation()
  return (
    <a className="ws-th-a ws-th-media" href={href} target="_blank" rel="noopener noreferrer">
      {t(media === 'image' ? 'thread.image' : 'thread.video')}
      <ExternalLink aria-hidden size="0.75rem" />
      <span className="sr-only">({t('thread.newTab')})</span>
    </a>
  )
}

/** A spoiler stays hidden until asked for: a button, then the text after it. */
function Spoiler({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className="ws-th-spoiler" data-open={open || undefined}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {t(open ? 'thread.hideSpoiler' : 'thread.showSpoiler')}
      </button>
      <span id={id} hidden={!open}>
        {children}
      </span>
    </span>
  )
}
