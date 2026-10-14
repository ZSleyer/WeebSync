import { describe, expect, it } from 'vitest'
import { categoryRows } from '../pages/settings/Notifications'

describe('categoryRows', () => {
  it('lists every category once, push ones first, mail-only ones after', () => {
    expect(categoryRows(['download_done', 'upgrade'], ['download_done', 'admin_new_user', 'upgrade'])).toEqual([
      'download_done',
      'upgrade',
      'admin_new_user',
    ])
  })

  it('keeps the mail categories when push is not set up', () => {
    expect(categoryRows([], ['download_failed'])).toEqual(['download_failed'])
  })
})
