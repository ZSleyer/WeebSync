import { describe, expect, it } from 'vitest'
import { spreadOf } from '../pages/Viewer'

describe('spreadOf', () => {
  it('keeps the cover alone and pairs the pages after it', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(spreadOf)).toEqual([0, 1, 1, 3, 3, 5, 5])
  })
})
