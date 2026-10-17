import { useDeferredValue, useId, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Skeleton } from 'fluid-lycoris'
import { api, type NameExplain, type NamePiece } from '../api'

/** The colour group of a piece kind: the tester paints every kind of one
 *  group alike (season, final, movie and OVA all say "which part"). */
export type KindGroup = 'title' | 'alt' | 'season' | 'ep' | 'year' | 'lang' | 'res' | 'other'

const GROUP: Record<string, KindGroup> = {
  title: 'title',
  alt: 'alt',
  season: 'season',
  final: 'season',
  movie: 'season',
  ova: 'season',
  episode: 'ep',
  version: 'ep',
  year: 'year',
  dub: 'lang',
  sub: 'lang',
  resolution: 'res',
}

export const kindGroup = (kind: string): KindGroup => GROUP[kind] ?? 'other'

/** One run of the name: plain text, or the piece at index `piece`. */
export interface Segment {
  text: string
  piece?: number
}

/**
 * Cuts the name at the pieces' UTF-16 offsets (how a JS string counts). A
 * piece without a place in the name, or one overlapping the one before, is
 * listed by the caller but not marked.
 */
export function segments(name: string, pieces: NamePiece[]): Segment[] {
  const out: Segment[] = []
  let at = 0
  for (const [i, p] of pieces.entries()) {
    if (p.start < 0 || p.start < at || p.end > name.length) continue
    if (p.start > at) out.push({ text: name.slice(at, p.start) })
    out.push({ text: name.slice(p.start, p.end), piece: i })
    at = p.end
  }
  if (at < name.length) out.push({ text: name.slice(at) })
  return out
}

// real names from the servers, one per rule the tester shows off
export const SAMPLES = [
  ['apothecary', 'Kusuriya no Hitorigoto 3rd Season (Die Tagebücher der Apothekerin S3) [GerJapDub,GerEngSub,CR]'],
  ['absolute', 'One Piece E1180 [1080p][AAC][JapDub][GerEngSub][Web-DL].mkv'],
  ['roman', 'Youjo Senki II (Saga of Tanya the Evil S2) [GerJapDub,GerEngSub,CR]'],
  ['year', 'Ranma 1 2 (2024) 3rd Season [GerJapDub,GerEngSub,NF]'],
] as const

/**
 * The rules page's name tester: a field prefilled with a real name, samples
 * that fill it, and the name again with every piece the server's parser
 * (/api/explain/name) reads painted in its kind's colour, plus one row per
 * piece. Pointing at a piece or a row lights up its partner.
 */
export function NameTester() {
  const { t } = useTranslation()
  const [name, setName] = useState<string>(SAMPLES[0][1])
  // typing should not fire a request per key; the deferred value lags a beat
  const deferred = useDeferredValue(name.trim())
  const id = useId()
  return (
    <section className="ws-tester" aria-labelledby={id + '-h'}>
      <h2 id={id + '-h'} className="ws-tester-h">
        <label htmlFor={id}>{t('explain.rules.tester')}</label>
      </h2>
      <p className="ws-tester-hint" id={id + '-hint'}>
        {t('explain.rules.testerHint')}
      </p>
      <textarea
        id={id}
        rows={3}
        value={name}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        aria-describedby={id + '-hint'}
        onChange={(e) => setName(e.target.value.slice(0, 1024))}
      />
      <div className="ws-samples" role="group" aria-label={t('explain.rules.samplesLabel')}>
        {SAMPLES.map(([key, sample]) => (
          <button key={key} type="button" onClick={() => setName(sample)} aria-pressed={name === sample}>
            {t(`explain.rules.samples.${key}`)}
          </button>
        ))}
      </div>
      <div aria-live="polite">{deferred && <Trace name={deferred} />}</div>
    </section>
  )
}

function Trace({ name }: { name: string }) {
  const { t } = useTranslation()
  const [hot, setHot] = useState<number | null>(null)
  const q = useQuery({
    queryKey: ['explain-name', name],
    queryFn: () => api.post<NameExplain>('/api/explain/name', { name }),
    staleTime: Infinity,
  })
  if (q.isPending) return <Skeleton className="mt-1" />
  if (q.isError) return <p className="text-err">{t('explain.failed')}</p>
  const pieces = q.data.pieces
  const hover = (i: number) => ({
    onPointerEnter: () => setHot(i),
    onPointerLeave: () => setHot(null),
  })
  const parts: ReactNode[] = segments(name, pieces).map((s, n) =>
    s.piece === undefined ? (
      s.text
    ) : (
      <span
        key={n}
        className={hot === s.piece ? 'ws-tk ws-hl' : 'ws-tk'}
        data-k={kindGroup(pieces[s.piece].kind)}
        title={t(`explain.piece.${pieces[s.piece].kind}`)}
        {...hover(s.piece)}
      >
        {s.text}
      </span>
    ),
  )
  return (
    <>
      <p className="ws-fname">{parts}</p>
      {pieces.length > 0 ? (
        <ul className="ws-trace" aria-label={t('explain.rules.traceLabel')}>
          {pieces.map((p, i) => (
            <li key={i} data-k={kindGroup(p.kind)} className={hot === i ? 'ws-hl' : undefined} {...hover(i)}>
              <span className="ws-kk">{t(`explain.piece.${p.kind}`)}</span>
              <span className="ws-kv">{p.value}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ws-quiet">{t('explain.rules.testerEmpty')}</p>
      )}
    </>
  )
}
