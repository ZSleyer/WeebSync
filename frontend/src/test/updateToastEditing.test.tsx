import { afterEach, describe, expect, it } from 'vitest'
import { editing } from '../components/UpdateToast'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('editing', () => {
  it('is false on a bare page and while a button has the focus', () => {
    document.body.innerHTML = '<button>go</button>'
    document.querySelector('button')!.focus()
    expect(editing()).toBe(false)
  })

  it('is true while a text field, textarea or select has the focus', () => {
    document.body.innerHTML = '<input id="a"><textarea id="b"></textarea><select id="c"></select>'
    for (const id of ['a', 'b', 'c']) {
      document.getElementById(id)!.focus()
      expect(editing()).toBe(true)
    }
  })

  it('ignores a checkbox, which holds no typed text', () => {
    document.body.innerHTML = '<input type="checkbox">'
    document.querySelector('input')!.focus()
    expect(editing()).toBe(false)
  })

  it('is true while a dirty form has armed its beforeunload guard', () => {
    const guard = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', guard)
    try {
      expect(editing()).toBe(true)
    } finally {
      window.removeEventListener('beforeunload', guard)
    }
    expect(editing()).toBe(false)
  })
})
