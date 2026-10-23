// The file's chapter marks for the player: as a WebVTT chapters track, which
// media-chrome reads to split the time bar into segments and name the one
// under the pointer, and the lookup the skip card and the dock title use.

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
