// JASSUB's worker, drawing on a synchronized canvas. JASSUB asks for a
// desynchronized (low-latency) context, which Chrome on Android hands to its
// own hardware layer above the page: that layer ignores the page's stacking
// and could turn opaque, a black sheet over the picture and the controls.
// Subtitles gain nothing from the lower latency.
const getContext = OffscreenCanvas.prototype.getContext
OffscreenCanvas.prototype.getContext = function (this: OffscreenCanvas, type: string, options?: object) {
  return getContext.call(this, type as '2d', { ...options, desynchronized: false })
} as typeof getContext

// a module import is evaluated before the lines above, but only defines the
// renderer: the context is asked for once JASSUB constructs it
import 'jassub/dist/worker/worker.js'
