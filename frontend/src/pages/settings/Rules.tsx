import { useEffect, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { Trans, useTranslation } from 'react-i18next'
import { scrollToSection } from '../../components/ScrollMemory'
import { NameTester } from '../../components/NameTester'
import './rules.css'

// ponytail: mirrors the points in internal/match PickExplain by hand. A test
// against match.go would keep it honest; add one if the scoring changes often.
const POINTS: [key: string, points: string][] = [
  ['title_fold', '+100'],
  ['title_strict', '+15'],
  ['words', 'upTo:50'],
  ['contained', '+25'],
  ['season_match', '+40'],
  ['season_miss', '−40'],
  ['season_base', '−10'],
  ['movie', '+30'],
  ['movie_tv', '−20'],
  ['ova', '+25'],
  ['year', '+10'],
  ['promo', '−60'],
  ['music', '−60'],
]
// match.MinScore
const MIN_SCORE = 20
// in the order a check meets them (internal/transfer EnqueueSkipping)
const SKIPS = [
  'outside_roots',
  'language',
  'worse_variant',
  'present',
  'owned',
  'uploading',
  'queued',
  'blocked',
  'foreign_target',
]
// the anchors the explanations link to: /rules#match lands on #r-match
const SECTIONS = ['names', 'scope', 'match', 'bundle', 'sync', 'files'] as const

/** Rich text of a rules string: <m> mono, <b> bold, <i> italic. */
function R({ k, values }: { k: string; values?: Record<string, unknown> }) {
  return (
    <Trans
      i18nKey={`explain.rules.${k}`}
      values={values}
      components={{ m: <span className="ws-mono" />, b: <b />, i: <i /> }}
    />
  )
}

function Dl({ base, keys }: { base: string; keys: string[] }) {
  const { t } = useTranslation()
  return (
    <dl className="ws-rules-dl">
      {keys.map((k) => (
        <div key={k} className="contents">
          <dt>{t(`explain.rules.${base}.${k}T`)}</dt>
          <dd>
            <R k={`${base}.${k}D`} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Section({ id, children }: { id: (typeof SECTIONS)[number]; children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <section id={`r-${id}`} aria-labelledby={`r-${id}-h`}>
      <h2 id={`r-${id}-h`}>{t(`explain.rules.${id}.title`)}</h2>
      {children}
    </section>
  )
}

// a link like /rules#match scrolls to its section once the page is there
function useHashTarget() {
  const { hash } = useLocation()
  useEffect(() => {
    const id = hash.slice(1)
    if (!id) return
    const el = document.getElementById(id.startsWith('r-') ? id : `r-${id}`)
    if (!el) return
    const still =
      matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off'
    // after the page's own entry has laid it out
    const raf = requestAnimationFrame(() => scrollToSection(el, 'start', still ? 'auto' : 'smooth'))
    return () => cancelAnimationFrame(raf)
  }, [hash])
}

/**
 * "How WeebSync decides": a name tester beside (on a phone: above) the rules
 * for reading names, finding sources, matching, bundling, syncing and files,
 * each stated as the backend does it.
 */
export default function Rules() {
  const { t } = useTranslation()
  useHashTarget()
  return (
    <div className="ws-rules">
      {/* the desktop's title; on a phone the app bar's h1 names the page */}
      <h1 className="ws-rules-h1">{t('explain.rules.title')}</h1>
      <div className="ws-rules-body">
        <NameTester />
        <Section id="names">
          <Dl base="names" keys={['season', 'lang', 'res', 'none']} />
        </Section>
        <Section id="scope">
          <p>
            <R k="scope.p1" />
          </p>
          <p>
            <R k="scope.p2" />
          </p>
        </Section>
        <Section id="match">
          <p>{t('explain.rules.match.intro')}</p>
          <div className="ws-tbl">
            <table>
              <caption className="sr-only">{t('explain.rules.match.pointsLabel')}</caption>
              <tbody>
                {POINTS.map(([key, pts]) => (
                  <tr key={key}>
                    <td>{t(`explain.rules.points.${key}`)}</td>
                    <td>{pts.startsWith('upTo:') ? t('explain.rules.match.upTo', { n: pts.slice(5) }) : pts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            <R k="match.after1" values={{ n: MIN_SCORE }} />
          </p>
          <p>
            <R k="match.after2" />
          </p>
          <p>{t('explain.rules.match.after3')}</p>
        </Section>
        <Section id="bundle">
          <p>{t('explain.rules.bundle.p')}</p>
        </Section>
        <Section id="sync">
          <Dl base="sync" keys={['pace', 'fail', 'gaps', 'behind', 'dub', 'abs']} />
          <p>{t('explain.rules.sync.skipsIntro')}</p>
          <ol className="ws-skips">
            {SKIPS.map((k) => (
              <li key={k}>
                <b>{t(`explain.rules.skip.${k}.head`)}</b>
                <span>{t(`explain.rules.skip.${k}.body`)}</span>
              </li>
            ))}
          </ol>
        </Section>
        <Section id="files">
          <Dl base="files" keys={['part', 'retry', 'trash', 'upgrades']} />
        </Section>
      </div>
    </div>
  )
}
