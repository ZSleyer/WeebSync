// The file's chapter marks for the player: as a WebVTT chapters track, which
// media-chrome reads to split the time bar into segments and name the one
// under the pointer, and the lookup the skip card and the dock title use.

import { useEffect, useState, type RefObject } from 'react'
import type { PlayChapter } from './PlayerInfo'

const stamp = (s: number) => {
  const ms = Math.round(s * 1000)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}

/** a cue text is one line of plain text: no markup, no line breaks, no arrow */
const cueText = (s: string) =>
  s
    .replace(/[\r\n]+/g, ' ')
    .replace(/-->/g, '→')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/** The chapters as a WebVTT file; an untitled chapter is called by its number. */
export function chaptersVtt(chapters: PlayChapter[], untitled: (n: number) => string): string {
  const cues = chapters.map((c, i) => `${stamp(c.start)} --> ${stamp(c.end)}\n${cueText(c.title || untitled(i + 1))}`)
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

/** The chapter playing at t seconds, if any. */
export const chapterAt = (chapters: PlayChapter[], t: number) => chapters.find((c) => t >= c.start && t < c.end)

/**
 * The chapter playing now, followed on the video; an opening or ending is
 * skippable until it is skipped or waved off (seeking back into it brings it
 * again).
 */
export function useChapterSkip(videoRef: RefObject<HTMLVideoElement | null>, chapters: PlayChapter[]) {
  const [chapter, setChapter] = useState<PlayChapter>()
  const [skipDone, setSkipDone] = useState<PlayChapter>()
  useEffect(() => {
    const v = videoRef.current
    if (!v || !chapters.length) {
      setChapter(undefined)
      return
    }
    // null: nothing synced for this list yet, so the first sync always sets,
    // even "no chapter here" after a list that had one at this time
    let last: PlayChapter | undefined | null = null
    const sync = () => {
      const c = chapterAt(chapters, v.currentTime)
      if (c === last) return
      last = c
      setChapter(c)
      setSkipDone(undefined)
    }
    sync()
    // seeking, not only seeked: a transcode restarts at the new place and
    // takes seconds to get there, the chapter has changed at once
    const events = ['timeupdate', 'seeking', 'seeked']
    for (const e of events) v.addEventListener(e, sync)
    return () => {
      for (const e of events) v.removeEventListener(e, sync)
    }
  }, [videoRef, chapters])
  const skippable = chapter?.kind && chapter !== skipDone ? chapter : undefined
  const skip = () => {
    const v = videoRef.current
    if (!v || !skippable) return
    v.currentTime = Math.min(skippable.end, v.duration || Infinity)
    setSkipDone(skippable)
  }
  const dismiss = () => setSkipDone(skippable)
  return { chapter, skippable, skip, dismiss }
}
