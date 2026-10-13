import { useQuery } from '@tanstack/react-query'
import { Skeleton } from 'fluid-lycoris'
import { useTranslation } from 'react-i18next'
import { api, type NameExplain, type NamePiece } from '../api'

/**
 * A file or folder name with the pieces WeebSync reads from it marked, and
 * what each piece means listed below. The pieces come from the server's own
 * parser (/api/explain/name), so the trace never shows something matching
 * does not see.
 */
export function NameTrace({ name, className }: { name: string; className?: string }) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['explain-name', name],
    queryFn: () => api.post<NameExplain>('/api/explain/name', { name }),
    enabled: name.trim() !== '',
    staleTime: Infinity,
  })
  if (!name.trim()) return null
  if (q.isPending) return <Skeleton className={className} />
  if (q.isError) return <p className="text-ctl-sm text-err">{t('explain.failed')}</p>
  const pieces = q.data.pieces
  return (
    <div className={className}>
      <p className="font-mono text-ctl-sm break-all text-t-primary">
        {marked(name, pieces, (k) => t(`explain.piece.${k}`))}
      </p>
      {pieces.length > 0 ? (
        <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-ctl-sm">
          {pieces.map((p, i) => (
            <div key={i} className="contents">
              <dt className="text-t-secondary">{t(`explain.piece.${p.kind}`)}</dt>
              <dd className="m-0 font-mono break-all">{p.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-ctl-sm text-t-secondary">{t('explain.rules.testerEmpty')}</p>
      )}
    </div>
  )
}

// marked cuts the name at the pieces' UTF-16 offsets, which is how a JS
// string counts; a piece without a position is listed, not marked
function marked(name: string, pieces: NamePiece[], label: (kind: string) => string) {
  const out: React.ReactNode[] = []
  let at = 0
  for (const [i, p] of pieces.entries()) {
    if (p.start < 0 || p.start < at) continue
    if (p.start > at) out.push(name.slice(at, p.start))
    out.push(
      <mark key={i} title={label(p.kind)} className="rounded-sm bg-accent/15 text-inherit">
        {name.slice(p.start, p.end)}
      </mark>,
    )
    at = p.end
  }
  out.push(name.slice(at))
  return out
}
