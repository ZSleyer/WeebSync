// Registers the jest-dom matchers on vitest's expect and unmounts whatever a
// test rendered. Globals are off, so testing-library cannot hook its own
// auto-cleanup and we schedule it here once for every suite.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(cleanup)

// jsdom 29 parses <dialog> but ships no behaviour for it: show, showModal and
// close are simply absent from the prototype, so a Dialog would throw on mount.
// The shim below is the smallest slice of the spec the component relies on -
// the open flag and the close event - and nothing else. The top layer, the
// backdrop and Escape-to-cancel stay unimplemented; tests that need those
// dispatch the corresponding event themselves.
if (!HTMLDialogElement.prototype.showModal) {
  const open = function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.show = open
  HTMLDialogElement.prototype.showModal = open
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, returnValue?: string) {
    if (!this.open) return
    if (returnValue !== undefined) this.returnValue = returnValue
    this.open = false
    // the spec queues this task; firing it synchronously keeps the tests free
    // of timer juggling and the component never depends on the delay
    this.dispatchEvent(new Event('close'))
  }
}
