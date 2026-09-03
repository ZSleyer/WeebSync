// assetRefs lists what a document loads: the hashed script and stylesheet
// urls, which change with every build. Comparing the list a tab booted with
// against the one served now tells whether a deploy happened underneath it.
export function assetRefs(doc: Document): string[] {
  return Array.from(doc.querySelectorAll('script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]'))
    .map((el) => el.getAttribute('src') || el.getAttribute('href') || '')
    .filter(Boolean)
    .sort()
}
