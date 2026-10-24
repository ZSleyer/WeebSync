import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WCAG 2.4.7: the ring must follow the browser's :focus-visible. Only a
// pointer press (data-input=pointer) may switch it off, not the absence of a
// navigation key.
const css = readFileSync(resolve(process.cwd(), '../design-system/src/fluid-lycoris.css'), 'utf8')

describe('focus ring policy', () => {
  it('switches rings off only after a pointer press', () => {
    expect(css).toContain(":root[data-input='pointer'] :is(:focus-visible, :focus-within)")
    expect(css).not.toContain(":root:not([data-input='keys']) :is(:focus-visible")
  })
})
