import { useState } from 'react'
import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '../api'
import type { Schemas } from '../api.gen'
import { useAnilistMe } from '../anilistMe'
import { useFailToast, useToast } from './toast'

// Replies and likes in the thread reader, written through to AniList as the
// linked user. Both land in the reader's cache at once and are taken back
// when AniList (or the switch in the settings) refuses them.

type ThreadPage = Schemas['anilist.ThreadPage']
type Comment = Schemas['anilist.ThreadComment']
export type ThreadData = InfiniteData<ThreadPage, number>

export type LikeTarget = { id: number; type: 'THREAD' | 'THREAD_COMMENT' }
type LikeState = { liked: boolean; likes: number }

/** Where a reply goes: under `parent` (0 = the thread), shown in the replies of `top`. */
export type ReplyTarget = { parent: number; top: number; name: string }

/** The thread data with one like set by `next` from its current state. */
export function withLike(d: ThreadData, to: LikeTarget, next: (cur: LikeState) => LikeState): ThreadData {
  const one = (c: Comment): Comment => {
    const replies = c.replies.map(one)
    if (to.type !== 'THREAD_COMMENT' || c.id !== to.id) return { ...c, replies }
    const n = next({ liked: c.isLiked, likes: c.likes })
    return { ...c, replies, isLiked: n.liked, likes: n.likes }
  }
  return {
    ...d,
    pages: d.pages.map((p, i) => {
      let thread = p.thread
      if (to.type === 'THREAD' && i === 0) {
        const n = next({ liked: thread.isLiked, likes: thread.likes })
        thread = { ...thread, isLiked: n.liked, likes: n.likes }
      }
      return { ...p, thread, comments: p.comments.map(one) }
    }),
  }
}

/** The thread data with `c` added where `to` says: a new top-level comment last, a reply last under its top. */
export function withReply(d: ThreadData, to: ReplyTarget, c: Comment): ThreadData {
  if (to.top === 0) {
    const pages = d.pages.slice()
    const last = pages[pages.length - 1]
    pages[pages.length - 1] = { ...last, comments: [...last.comments, c] }
    return { ...d, pages }
  }
  return {
    ...d,
    pages: d.pages.map((p) => ({
      ...p,
      comments: p.comments.map((x) => (x.id === to.top ? { ...x, replies: [...x.replies, c] } : x)),
    })),
  }
}

/** The thread data with the comment `from` renamed to `to` (a pending reply getting its real id). */
export function withId(d: ThreadData, from: number, to: number): ThreadData {
  const one = (c: Comment): Comment => ({ ...(c.id === from ? { ...c, id: to } : c), replies: c.replies.map(one) })
  return { ...d, pages: d.pages.map((p) => ({ ...p, comments: p.comments.map(one) })) }
}

/** The thread data without the comment `id` (a pending reply that was refused). */
export function withoutComment(d: ThreadData, id: number): ThreadData {
  const one = (c: Comment): Comment => ({ ...c, replies: c.replies.filter((r) => r.id !== id).map(one) })
  return { ...d, pages: d.pages.map((p) => ({ ...p, comments: p.comments.filter((c) => c.id !== id).map(one) })) }
}

export function useThreadWrites(threadId: number) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useToast()
  const failToast = useFailToast()
  const { data: me } = useAnilistMe()
  const key = ['anilist-thread', threadId]
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null)
  const [draft, setDraft] = useState('')

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 403) {
      toast({ message: t('thread.turnedOff'), error: true })
      void qc.invalidateQueries({ queryKey: ['anilist-me'] })
    } else if (e instanceof ApiError && e.status === 429) toast({ message: t('thread.tooFast'), error: true })
    else failToast(e)
  }
  const set = (fn: (d: ThreadData) => ThreadData) => qc.setQueryData<ThreadData>(key, (d) => (d ? fn(d) : d))

  const like = useMutation({
    mutationFn: (to: LikeTarget) => api.post<LikeState>('/api/anilist/likes', { ...to, threadId }),
    onMutate: async (to) => {
      await qc.cancelQueries({ queryKey: key })
      // only this like is taken back on failure: a whole-cache snapshot would
      // also drop what was written while this request was out
      let before: LikeState | undefined
      set((d) =>
        withLike(d, to, (c) => {
          before = c
          return { liked: !c.liked, likes: Math.max(0, c.likes + (c.liked ? -1 : 1)) }
        }),
      )
      return before
    },
    onError: (e, to, before) => {
      if (before) set((d) => withLike(d, to, () => before))
      fail(e)
    },
    onSuccess: (r, to) => set((d) => withLike(d, to, () => r)),
  })

  const send = useMutation({
    mutationFn: (v: ReplyTarget & { text: string; tmp: number }) =>
      api.post<{ id: number }>(`/api/anilist/threads/${threadId}/comments`, {
        comment: v.text,
        ...(v.parent ? { parentCommentId: v.parent } : {}),
      }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key })
      const pending: Comment = {
        id: v.tmp,
        body: v.text,
        likes: 0,
        isLiked: false,
        createdAt: Math.floor(Date.now() / 1000),
        user: { name: me?.name || '', avatar: me?.avatar },
        replyTo: v.parent && v.parent !== v.top ? v.name : undefined,
        replies: [],
      }
      set((d) => withReply(d, v, pending))
      setReplyTo(null)
      setDraft('')
    },
    onError: (e, v) => {
      // only the pending reply goes; a reply written meanwhile stays
      set((d) => withoutComment(d, v.tmp))
      // the words come back into the open composer, nothing typed is lost
      setReplyTo({ parent: v.parent, top: v.top, name: v.name })
      setDraft(v.text)
      fail(e)
    },
    onSuccess: (r, v) => set((d) => withId(d, v.tmp, r.id)),
  })

  return {
    /** the user is linked and allowed replies and likes */
    canWrite: !!me?.connected && !!me.allow?.social,
    linked: !!me?.connected,
    like: (to: LikeTarget) => like.mutate(to),
    replyTo,
    open: (to: ReplyTarget) => {
      setReplyTo(to)
      setDraft('')
    },
    cancel: () => setReplyTo(null),
    draft,
    setDraft,
    sending: send.isPending,
    send: () => {
      const text = draft.trim()
      if (!replyTo || !text) return
      send.mutate({ ...replyTo, text, tmp: -Date.now() })
    },
  }
}
