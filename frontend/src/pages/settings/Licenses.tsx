import { useDeferredValue, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Disclosure, Input, LoadingIndicator, ScrollRegion, TextLink } from 'fluid-lycoris'

export type LicenseSource = 'data' | 'go' | 'npm' | 'os'
export interface LicenseEntry {
  name: string
  version: string
  license: string
  url: string
  source: LicenseSource
  /** key into texts.json */
  text?: string
}

const SOURCES: LicenseSource[] = ['data', 'go', 'npm', 'os']
// the image build can drop the Debian packages it ships here; a build
// without it (dev, a binary) answers with the app's index page instead
export const OS_LIST_URL = '/licenses/os.json'

const isEntry = (e: unknown): e is LicenseEntry => {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  return (
    typeof o.name === 'string' &&
    typeof o.version === 'string' &&
    typeof o.license === 'string' &&
    typeof o.url === 'string' &&
    o.url.startsWith('https://')
  )
}

// loadOsList: the image's OS packages, or none when the file is not there
// (the SPA fallback answers 200 with HTML) or not what it should be
export async function loadOsList(): Promise<LicenseEntry[]> {
  try {
    const res = await fetch(OS_LIST_URL, { headers: { Accept: 'application/json' } })
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return []
    const body: unknown = await res.json()
    const list = Array.isArray(body) ? body : (body as { entries?: unknown })?.entries
    if (!Array.isArray(list)) return []
    return list
      .filter(isEntry)
      .map(({ name, version, license, url }) => ({ name, version, license, url, source: 'os' }))
  } catch {
    return []
  }
}

// both JSON files are their own chunks: nothing of them is in the app's
// main bundle, and the texts only load when one is opened
const loadInventory = async () => (await import('../../licenses/inventory.json')).default as LicenseEntry[]
const loadTexts = async () => (await import('../../licenses/texts.json')).default as Record<string, string>

function LicenseText({ id, name }: { id: string; name: string }) {
  const { t } = useTranslation()
  const texts = useQuery({ queryKey: ['licenses', 'texts'], queryFn: loadTexts, staleTime: Infinity })
  if (texts.isPending) return <LoadingIndicator label={t('about.licenses.loading')} />
  if (texts.isError) return <p className="sf-note text-warn">{t('about.licenses.loadFailed')}</p>
  // scrolls on its own: the region is focusable, so a keyboard can scroll it too
  return (
    <ScrollRegion className="set-lic-text" aria-label={t('about.licenses.textOf', { name })}>
      <pre>{texts.data[id] ?? ''}</pre>
    </ScrollRegion>
  )
}

function Entry({ e }: { e: LicenseEntry }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const textId = useId()
  return (
    <li className="set-lic-row">
      <div className="set-lic-head">
        <TextLink href={e.url} target="_blank" rel="noreferrer">
          {e.name} <ExternalLink aria-hidden size="1em" />
        </TextLink>
        <span className="font-mono sf-note">{e.version}</span>
        <Badge>{e.license}</Badge>
        {e.text && (
          <TextLink
            aria-expanded={open}
            aria-controls={textId}
            onClick={() => setOpen((o) => !o)}
            aria-label={t('about.licenses.textOf', { name: e.name })}
          >
            {t('about.licenses.text')}
          </TextLink>
        )}
      </div>
      {e.text && <div id={textId}>{open && <LicenseText id={e.text} name={e.name} />}</div>}
    </li>
  )
}

function Inventory() {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const q = useDeferredValue(query.trim().toLowerCase())
  const searchId = useId()
  const inventory = useQuery({ queryKey: ['licenses', 'inventory'], queryFn: loadInventory, staleTime: Infinity })
  const os = useQuery({ queryKey: ['licenses', 'os'], queryFn: loadOsList, staleTime: Infinity })

  if (inventory.isPending) return <LoadingIndicator label={t('about.licenses.loading')} />
  if (inventory.isError) return <p className="sf-note text-warn">{t('about.licenses.loadFailed')}</p>

  const all = [...inventory.data, ...(os.data ?? [])]
  const hits = q ? all.filter((e) => e.name.toLowerCase().includes(q) || e.license.toLowerCase().includes(q)) : all
  return (
    <div className="set-lic">
      <label htmlFor={searchId} className="sr-only">
        {t('about.licenses.search')}
      </label>
      <Input
        id={searchId}
        type="search"
        size="sm"
        value={query}
        placeholder={t('about.licenses.search')}
        onChange={(ev) => setQuery(ev.target.value)}
      />
      <p className="sf-note" role="status">
        {t('about.licenses.count', { count: hits.length, total: all.length })}
      </p>
      {SOURCES.map((s) => {
        const group = hits.filter((e) => e.source === s)
        if (!group.length) return null
        return (
          // a search opens every group it found something in; clearing it folds them again
          <Disclosure
            key={`${s}:${q ? 'search' : 'all'}`}
            small
            title={t(`about.licenses.source.${s}`)}
            count={group.length}
            defaultOpen={!!q}
          >
            <ul className="set-lic-list">
              {group.map((e) => (
                <Entry key={`${e.source}:${e.name}@${e.version}`} e={e} />
              ))}
            </ul>
          </Disclosure>
        )
      })}
    </div>
  )
}

// ThirdPartyLicenses: what the app ships from others and under which terms,
// loaded only when the section is opened (a closed Disclosure mounts nothing)
export default function ThirdPartyLicenses() {
  const { t } = useTranslation()
  return (
    <Disclosure title={t('about.licenses.title')} defaultOpen={false}>
      <p className="sf-note">{t('about.licenses.intro')}</p>
      <Inventory />
    </Disclosure>
  )
}
