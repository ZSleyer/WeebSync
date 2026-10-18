import { useTranslation } from 'react-i18next'
import anilistMark from '../assets/providers/anilist.svg'
import tmdbMark from '../assets/providers/tmdb.svg'
import tvdbMark from '../assets/providers/tvdb.png'
import './sourceLine.css'

/** The providers' own marks, as their terms allow; Crunchyroll has none here and shows as text. */
const MARKS: Record<string, { src: string; wide?: boolean }> = {
  AniList: { src: anilistMark },
  TMDB: { src: tmdbMark, wide: true },
  TVDB: { src: tvdbMark, wide: true },
}

/** A provider's mark (its name is the alt text) or, without one, its name. The square AniList icon gets its name beside it. */
export function ProviderMark({ name }: { name: string }) {
  const m = MARKS[name]
  if (!m) return <b>{name}</b>
  return (
    <>
      <img
        src={m.src}
        alt={m.wide ? name : ''}
        loading="lazy"
        decoding="async"
        className="ws-d-pmark"
        data-wide={m.wide || undefined}
        data-provider={name}
      />
      {!m.wide && <b>{name}</b>}
    </>
  )
}

type Row = { name: string; href?: string; role: string }

/**
 * Where the title's data comes from, as a quiet block at the end of the
 * overview: the provider behind the page (it links to the title there), then
 * the other providers a section leans on - dub dates from Crunchyroll, the
 * episode numbering from TVDB or TMDB. Only what is actually in use shows.
 */
export default function SourceLine({
  primary,
  dubDates,
  mappedBy,
}: {
  /** the provider the page's record came from, with the title's page there */
  primary: { label: string; href: string }
  /** the watch's dub slots come from Crunchyroll */
  dubDates?: boolean
  /** tvdb or tmdb, when the watch numbers its episodes by one of them */
  mappedBy?: string
}) {
  const { t } = useTranslation()
  const rows: Row[] = [
    {
      name: primary.label,
      href: primary.href,
      role: t(primary.label === 'AniList' ? 'series.src.roleAnilist' : 'series.src.role'),
    },
  ]
  const mapper = mappedBy === 'tvdb' ? 'TVDB' : mappedBy === 'tmdb' ? 'TMDB' : ''
  if (mapper && mapper !== primary.label) rows.push({ name: mapper, role: t('series.src.numbering') })
  if (dubDates) rows.push({ name: 'Crunchyroll', role: t('series.src.dubs') })
  return (
    <section className="ws-d-src" aria-labelledby="ws-src-h">
      <h3 id="ws-src-h" className="ws-d-h3">
        {t('series.src.title')}
      </h3>
      <ul>
        {rows.map((r) => {
          const body = (
            <>
              <ProviderMark name={r.name} />
              <span className="ws-d-quiet">{r.role}</span>
            </>
          )
          return (
            <li key={r.name}>
              {r.href ? (
                <a href={r.href} target="_blank" rel="noreferrer">
                  {body}
                </a>
              ) : (
                <span>{body}</span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
