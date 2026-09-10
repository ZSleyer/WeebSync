import { LOGO_H, LOGO_PATH_S, LOGO_PATH_W, LOGO_W } from './logo'

// The tab icon is the mark with the S in the current accent. It is built on
// the fly and handed to the browser as a data URL, so a new accent shows in
// the tab at once. The W follows the browser's own colour scheme, not the
// app's theme: the tab strip is the browser's surface.
export function faviconSvg(accent: string): string {
  const pad = (LOGO_W - LOGO_H) / 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-pad} ${LOGO_W} ${LOGO_W}">` +
    `<style>.w{fill:#0a1628}@media(prefers-color-scheme:dark){.w{fill:#f4f6f8}}</style>` +
    `<path class="w" d="${LOGO_PATH_W}"/><path fill="${accent}" d="${LOGO_PATH_S}"/></svg>`
  )
}

export function currentAccent(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-blue').trim()
  return v || '#ffa14a'
}

export function setFavicon(accent = currentAccent()) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (link) link.href = `data:image/svg+xml;utf8,${encodeURIComponent(faviconSvg(accent))}`
}
