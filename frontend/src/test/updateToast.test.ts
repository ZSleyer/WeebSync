import { describe, expect, it } from 'vitest'
import { assetRefs } from '../components/assetRefs'

const page = (js: string) =>
  new DOMParser().parseFromString(
    `<html><head><link rel="stylesheet" href="/assets/index-a1.css"><script type="module" src="${js}"></script></head><body></body></html>`,
    'text/html',
  )

describe('assetRefs', () => {
  it('changes with the bundle hash', () => {
    const a = assetRefs(page('/assets/index-b1.js'))
    expect(a).toEqual(['/assets/index-a1.css', '/assets/index-b1.js'])
    expect(assetRefs(page('/assets/index-b2.js'))).not.toEqual(a)
    expect(assetRefs(page('/assets/index-b1.js'))).toEqual(a)
  })
  it('is empty for a page without bundles', () => {
    expect(assetRefs(new DOMParser().parseFromString('<p>login</p>', 'text/html'))).toEqual([])
  })
})
