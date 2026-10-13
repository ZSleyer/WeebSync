import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
// Vite turns the query into a URL string; the worker is our own file, so the
// CSP's script-src 'self' covers it
// eslint-disable-next-line import/default
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import Loading from '../components/Loading'
import { doneKey, streamUrl } from '../components/playLinks'
import { Paged, useBookEnd } from './Viewer'

GlobalWorkerOptions.workerSrc = workerUrl

// ponytail: no cMaps, standard fonts or wasm decoders are shipped, so a PDF
// with unembedded CJK fonts or JPEG 2000 pictures renders incomplete. Scanned
// volumes (plain JPEG pages) are what the library holds; ship them when one
// turns up that needs them.

/**
 * A PDF through pdf.js: the browser's own viewer is not there on Android, and
 * the app's policy keeps it out of a frame anyway. Pages are fetched by range,
 * so a 300 MB volume opens at its first page.
 */
export default function ViewerPdf({ server, path }: { server: number; path: string }) {
  const { t } = useTranslation()
  const end = useBookEnd(server, path)
  const doc = useQuery({
    queryKey: ['pdf', server, path],
    queryFn: () => getDocument({ url: streamUrl(server, path), disableAutoFetch: true, enableXfa: false }).promise,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })
  useEffect(() => () => void doc.data?.loadingTask.destroy(), [doc.data])
  if (doc.isPending)
    return (
      <div className="ws-rd-state">
        <Loading />
      </div>
    )
  if (doc.error)
    return (
      <div className="ws-rd-state">
        <p role="alert">
          {t('viewer.loadError')} {doc.error.message}
        </p>
      </div>
    )
  const pdf = doc.data
  return (
    <Paged
      count={pdf.numPages}
      page={`viewer.page:${server}:${path}`}
      done={doneKey(server, path)}
      direction="western"
      kind="pdf"
      label={path.split('/').pop() ?? ''}
      end={end}
      render={(i, fit) => (
        <PdfPage key={i} pdf={pdf} n={i + 1} fit={fit} alt={t('viewer.pageOf', { page: i + 1, count: pdf.numPages })} />
      )}
    />
  )
}

/** One page drawn to a canvas at the size the reader gives it, sharp at any pixel ratio. */
function PdfPage({ pdf, n, fit, alt }: { pdf: PDFDocumentProxy; n: number; fit: 'width' | 'height'; alt: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  // the reader's page area decides the scale. It is read when drawing, so the
  // first page does not wait for an observer; a resize only asks for a redraw.
  const [resized, setResized] = useState(0)
  // the draw in flight: pdf.js refuses a second render() on a canvas until
  // the first one has really stopped, and a cancel only asks it to
  const drawing = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => {
    const box = canvas.current?.parentElement
    if (!box) return
    const ro = new ResizeObserver(() => setResized((n) => n + 1))
    ro.observe(box)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const c = canvas.current
    const box = c?.parentElement
    if (!c || !box) return
    const size = { w: box.clientWidth, h: box.clientHeight }
    let task: { cancel: () => void } | undefined
    let gone = false
    const before = drawing.current
    drawing.current = Promise.all([pdf.getPage(n), before])
      .then(([page]) => {
        if (gone) return
        const base = page.getViewport({ scale: 1 })
        const scale = fit === 'width' ? size.w / base.width : Math.min(size.w / base.width, size.h / base.height)
        const dpr = window.devicePixelRatio || 1
        const vp = page.getViewport({ scale: scale * dpr })
        c.width = Math.floor(vp.width)
        c.height = Math.floor(vp.height)
        c.style.width = `${Math.floor(vp.width / dpr)}px`
        c.style.height = `${Math.floor(vp.height / dpr)}px`
        const r = page.render({ canvas: c, viewport: vp })
        task = r
        return r.promise.catch(() => {}) // cancelled by a page turn or a resize
      })
      .catch(() => {}) // a page that fails to load leaves the next draw free
    return () => {
      gone = true
      task?.cancel()
    }
  }, [pdf, n, fit, resized])
  return <canvas ref={canvas} role="img" aria-label={alt} className="bg-white" />
}
