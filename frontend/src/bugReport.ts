// The technical details an error page offers for a bug report. Everything in
// it passes redact() first: best effort, so a report pasted into a public
// issue carries the error and where it happened, not who or what it was about.

const RULES: [RegExp, string][] = [
  // a URL keeps its path (the bundle names matter), never its host or query
  [/\bhttps?:\/\/[^\s/'"()]+/gi, '<origin>'],
  [/\?[^\s'"()#]+/g, '?<query>'],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>'],
  // not after a slash: Chrome/141.0.0.0 is a version, not an address
  [/(?<![\w/.])\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<ip>'],
  // IPv6 only in full or with its gap, so a clock time is no address
  [/\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, '<ip>'],
  [/(?:[0-9a-f]{1,4})?(?::[0-9a-f]{1,4})*::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?/gi, '<ip>'],
  // home directories and Windows profiles name the person
  [/(\/(home|Users)\/|[A-Za-z]:\\Users\\)[^\s/\\'"]+/g, '<home>'],
  // a path two folders deep or more is a library or server layout
  [/(?<![\w<>])\/(?!assets\/)(?:[^\s/'"()<>:]+\/){2,}[^\s'"()<>:]*/g, '<path>'],
  // tokens, keys, session ids: long runs of hex or base64
  [/\b[A-Za-z0-9_-]{32,}\b/g, '<secret>'],
  [/\b[0-9a-f]{24,}\b/gi, '<secret>'],
]

export function redact(text: string): string {
  return RULES.reduce((s, [re, to]) => s.replace(re, to), text)
}

export function bugReport(error: unknown, extra: { version?: string } = {}): string {
  const e = error instanceof Error ? error : new Error(String(error))
  const build = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src.split('/').pop()
  const lines = [
    'WeebSync error report',
    `Time: ${new Date().toISOString()}`,
    `Version: ${extra.version ?? '?'} (${build ?? 'no bundle'})`,
    `Screen: ${location.pathname}${location.search}`,
    `Browser: ${navigator.userAgent}`,
    `Viewport: ${innerWidth}x${innerHeight} @${devicePixelRatio}`,
    `Language: ${document.documentElement.lang || navigator.language}`,
    '',
    `${e.name}: ${e.message}`,
    ...(e.stack ?? '')
      .split('\n')
      .filter((l) => l.trim() && !l.includes(e.message))
      .slice(0, 15),
  ]
  return redact(lines.join('\n'))
}
