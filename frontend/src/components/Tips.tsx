import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Lightbulb, X } from 'lucide-react'
import { Button, IconButton, Panel, useMediaQuery } from 'fluid-lycoris'
import { api, type Tips as TipsState } from '../api'
import { WIDE_MQ } from './PageActions'

// One-time hints, one at a time, at the top of the page. A closed hint is
// remembered by the server per account, so closing it on the desktop also
// closes it on the phone. The keys are free strings; the backend only checks
// their shape.

// The desktop's way onto the phone is PhoneHint in the sidebar, not a hint here.
export type TipKey = 'install-pwa'

export interface TipEnv {
  // a mouse on a wide screen
  desktop: boolean
  // a finger is the main pointer
  touch: boolean
  // running as the installed app, or installed during this visit
  installed: boolean
}

// pickTip decides which hint shows, if any. The order is the priority.
export function pickTip(env: TipEnv, dismissed: readonly string[]): TipKey | null {
  const wanted: TipKey[] = []
  if (env.touch && !env.installed) wanted.push('install-pwa')
  return wanted.find((k) => !dismissed.includes(k)) ?? null
}

// The browsers that cannot be asked to install get the steps in words.
// iPadOS reports itself as a Mac and is told apart by its touch points.
export function installHint(ua: string, touchPoints: number): 'ios' | 'firefox' | 'other' {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios'
  if (/Android/.test(ua) && /Firefox/.test(ua)) return 'firefox'
  return 'other'
}

// Chromium's install offer. It fires once, often before the app has even
// signed in, and the page below remounts on every navigation, so it is caught
// here at load and kept for the whole visit.
interface InstallPrompt extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let offer: InstallPrompt | null = null
let installedNow = false
const subscribers = new Set<() => void>()
const changed = () => subscribers.forEach((f) => f())

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // keeps the browser's own banner away; the hint offers the same
    e.preventDefault()
    offer = e as InstallPrompt
    changed()
  })
  window.addEventListener('appinstalled', () => {
    installedNow = true
    offer = null
    changed()
  })
}

const subscribe = (f: () => void) => {
  subscribers.add(f)
  return () => subscribers.delete(f)
}
const useOffer = () => useSyncExternalStore(subscribe, () => offer)
const useInstalledNow = () => useSyncExternalStore(subscribe, () => installedNow)

export default function Tips() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  // nothing shows until the list is in: a hint closed elsewhere must not flash
  const { data } = useQuery({
    queryKey: ['tips'],
    queryFn: () => api.get<TipsState>('/api/auth/tips'),
    staleTime: Infinity,
  })
  const desktop = useMediaQuery(`(pointer: fine) and ${WIDE_MQ}`)
  const touch = useMediaQuery('(pointer: coarse)')
  const standalone = useMediaQuery('(display-mode: standalone)')
  const installPrompt = useOffer()
  const installedNow = useInstalledNow()
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true

  if (!data) return null
  const tip = pickTip({ desktop, touch, installed: standalone || iosStandalone || installedNow }, data.dismissed)
  if (!tip) return null

  // hidden at once; a failed request only means it comes back next visit
  const dismiss = () => {
    qc.setQueryData<TipsState>(['tips'], (d) => ({ dismissed: [...(d?.dismissed ?? []), tip] }))
    api.post('/api/auth/tips/dismiss', { key: tip }).catch(() => {})
  }

  const install = async () => {
    if (!installPrompt) return
    try {
      await installPrompt.prompt()
      const { outcome } = await installPrompt.userChoice
      if (outcome === 'accepted') dismiss()
    } catch {
      /* the browser refused; the steps in words remain */
    }
    // the offer can be used only once; dropped after the answer, so the
    // hint does not change its words under the browser's dialog
    offer = null
    changed()
  }

  const body = installPrompt
    ? t('tips.installPrompt')
    : {
        ios: t('tips.installIos'),
        firefox: t('tips.installFirefox'),
        other: t('tips.installOther'),
      }[installHint(navigator.userAgent, navigator.maxTouchPoints)]

  return (
    <Panel as="aside" aria-label={t('tips.label')} className="mb-4 flex items-start gap-3 p-3 lg:mb-6">
      <Lightbulb aria-hidden size="1.25em" className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-t-secondary">{body}</p>
        {tip === 'install-pwa' && installPrompt && (
          <Button size="sm" variant="primary" className="mt-2" onClick={install}>
            <Download aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('tips.install')}
          </Button>
        )}
      </div>
      <IconButton
        aria-label={t('tips.close')}
        title={t('tips.close')}
        onClick={dismiss}
        className="-my-1 -mr-1 shrink-0 text-t-muted hover:text-t-primary"
      >
        <X aria-hidden size="1em" />
      </IconButton>
    </Panel>
  )
}
