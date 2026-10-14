import { describe, expect, it } from 'vitest'
import { withId, withLike, withReply, type ThreadData } from '../components/threadWrites'

const c = (id: number, likes = 0, replies: ThreadData['pages'][number]['comments'] = []) => ({
  id,
  body: `c${id}`,
  likes,
  isLiked: false,
  createdAt: 0,
  user: { name: `u${id}` },
  replies,
})

const data = (): ThreadData => ({
  pageParams: [1, 2],
  pages: [
    {
      thread: {
        id: 9,
        title: 't',
        body: 'b',
        replies: 3,
        views: 1,
        createdAt: 0,
        url: '',
        user: { name: 'op' },
        likes: 4,
        isLiked: false,
      },
      comments: [c(1, 2, [c(2, 1)])],
      hasNextPage: true,
    },
    { thread: {} as never, comments: [c(3)], hasNextPage: false },
  ],
})

describe('thread cache updates', () => {
  it('sets a like on the thread or on a reply deep down', () => {
    const t = withLike(data(), { id: 9, type: 'THREAD' }, (s) => ({ liked: !s.liked, likes: s.likes + 1 }))
    expect(t.pages[0].thread).toMatchObject({ likes: 5, isLiked: true })
    const r = withLike(data(), { id: 2, type: 'THREAD_COMMENT' }, () => ({ liked: true, likes: 7 }))
    expect(r.pages[0].comments[0].replies[0]).toMatchObject({ likes: 7, isLiked: true })
    expect(r.pages[0].comments[0]).toMatchObject({ likes: 2, isLiked: false })
  })

  it('adds a top-level reply last and a reply under its top-level comment', () => {
    const top = withReply(data(), { parent: 0, top: 0, name: 'op' }, c(-1))
    expect(top.pages[1].comments.map((x) => x.id)).toEqual([3, -1])
    const sub = withReply(data(), { parent: 2, top: 1, name: 'u2' }, c(-2))
    expect(sub.pages[0].comments[0].replies.map((x) => x.id)).toEqual([2, -2])
    expect(withId(sub, -2, 55).pages[0].comments[0].replies.map((x) => x.id)).toEqual([2, 55])
  })
})
