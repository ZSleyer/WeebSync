import { useDeferredValue, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input, Panel } from '@weebsync/design-system'
import { NameTrace } from '../../components/NameTrace'

// ponytail: mirrors the points in internal/match PickExplain by hand. A test
// against match.go would keep it honest; add one if the scoring changes often.
const POINTS: [code: string, points: string, arg?: string][] = [
  ['title_fold', '+100'],
  ['title_strict', '+15'],
  ['words', '+0 … +50', '0 … 100'],
  ['contained', '+25'],
  ['season', '+40 / -10 / -40', 'N'],
  ['movie_format', '+30 / -20', 'MOVIE / TV'],
  ['ova_format', '+25', 'OVA'],
  ['year', '+10', 'YYYY'],
  ['promo', '-60'],
]
const SKIPS = ['language', 'worse_variant', 'owned', 'uploading', 'queued', 'blocked', 'outside_roots']

/**
 * "How WeebSync decides": a name tester on top that shows what the server
 * reads from a name, then the matching and download rules in plain words.
 */
export default function Rules() {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  // typing should not fire a request per key; the deferred value lags a beat
  const deferred = useDeferredValue(name)
  const inputId = useId()
  return (
    <>
      <Panel as="section" className="mb-4 p-5" aria-labelledby={inputId + '-h'}>
        <h2 id={inputId + '-h'} className="font-display font-semibold tracking-wider">
          {t('explain.rules.tester')}
        </h2>
        <p className="mt-1 text-sm text-t-secondary">{t('explain.rules.testerHint')}</p>
        <label htmlFor={inputId} className="sr-only">
          {t('explain.rules.tester')}
        </label>
        <Input
          id={inputId}
          className="mt-3 font-mono"
          value={name}
          spellCheck={false}
          autoComplete="off"
          placeholder="Kusuriya no Hitorigoto 3rd Season [GerJapDub,GerEngSub,CR]"
          onChange={(e) => setName(e.target.value.slice(0, 1024))}
        />
        <div aria-live="polite">{deferred.trim() && <NameTrace name={deferred} className="mt-3" />}</div>
      </Panel>
      <Panel as="section" className="mb-4 p-5" aria-label={t('explain.rules.matchTitle')}>
        <h2 className="font-display font-semibold tracking-wider">{t('explain.rules.matchTitle')}</h2>
        <p className="mt-1 max-w-prose text-sm text-t-secondary">{t('explain.rules.matchText')}</p>
        <h3 className="mt-4 text-sm font-medium">{t('explain.rules.pointsTitle')}</h3>
        <dl className="mt-1 grid grid-cols-[minmax(0,1fr)_max-content] gap-x-4 gap-y-1 text-sm">
          {POINTS.map(([code, pts, arg]) => (
            <div key={code} className="contents">
              <dt className="text-t-secondary">{t(`explain.match.signal.${code}`, { arg: arg ?? '' })}</dt>
              <dd className="m-0 text-right font-mono tabular-nums">{pts}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-ctl-sm text-t-secondary">{t('explain.match.bar', { n: 20 })}</p>
      </Panel>
      <Panel as="section" className="mb-4 p-5" aria-label={t('explain.rules.loadTitle')}>
        <h2 className="font-display font-semibold tracking-wider">{t('explain.rules.loadTitle')}</h2>
        <p className="mt-1 max-w-prose text-sm text-t-secondary">{t('explain.rules.loadText')}</p>
        <ul className="mt-2 grid list-disc gap-1 pl-5 text-sm">
          {SKIPS.map((k) => (
            <li key={k}>{t(k === 'worse_variant' ? 'explain.skips.worse_variant_rule' : `explain.skips.${k}`)}</li>
          ))}
        </ul>
      </Panel>
    </>
  )
}
