import { LOGO_H, LOGO_PATH_S, LOGO_PATH_W, LOGO_W } from './logo'

// The tab icon is the mark as the header shows it: the W in the first accent,
// the S in the second. It is built on the fly and handed to the browser as a
// data URL, so a new accent or theme shows in the tab at once.
export function faviconSvg(w: string, s: string): string {
  const pad = (LOGO_W - LOGO_H) / 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-pad} ${LOGO_W} ${LOGO_W}">` +
    `<path fill="${w}" d="${LOGO_PATH_W}"/><path fill="${s}" d="${LOGO_PATH_S}"/></svg>`
  )
}

const token = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

export function setFavicon(w = token('--accent', '#ef6177'), s = token('--accent-2', '#33c2b5')) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (link) link.href = `data:image/svg+xml;utf8,${encodeURIComponent(faviconSvg(w, s))}`
}
