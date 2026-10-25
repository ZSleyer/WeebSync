// Document Picture-in-Picture (Chrome 116+ and Firefox 151+ on the desktop):
// an always-on-top window the page fills itself. The player's video moves in
// together with libass's canvas, so the subtitles float along; the browser's
// own video window shows the bare picture only.
// https://developer.chrome.com/docs/web-platform/document-picture-in-picture

export interface DocPipApi {
  window: Window | null
  requestWindow: (opts?: { width?: number; height?: number }) => Promise<Window>
}

export const docPipApi = (): DocPipApi | null =>
  (window as Window & { documentPictureInPicture?: DocPipApi }).documentPictureInPicture ?? null

/** whether the video floats, in the browser's own window or in ours */
export const floating = (video: HTMLVideoElement) =>
  document.pictureInPictureElement === video || !!docPipApi()?.window?.document.contains(video)

// the window starts empty: the page's style sheets (a one-time copy, as the
// API asks) and the root's look (theme, scheme, language) come across
export function mirrorDocument(from: Document, to: Document) {
  for (const sheet of from.styleSheets) {
    try {
      const style = to.createElement('style')
      style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n')
      to.head.appendChild(style)
    } catch {
      // a sheet of another origin keeps its rules to itself: linked again
      if (!sheet.href) continue
      const link = to.createElement('link')
      link.rel = 'stylesheet'
      link.href = sheet.href
      to.head.appendChild(link)
    }
  }
  for (const a of from.documentElement.attributes) to.documentElement.setAttribute(a.name, a.value)
}

/** the height of the window's button row, under the picture */
export const DOC_PIP_BAR = 56
