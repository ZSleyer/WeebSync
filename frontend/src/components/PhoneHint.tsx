import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Smartphone } from 'lucide-react'
import { Button } from 'fluid-lycoris'
import qrcode from 'qrcode-generator'
import { api, type Tips as TipsState } from '../api'
import { useToast } from './toast'

const KEY = 'mobile-ui'

/** The modules of a QR code for `text`, as one SVG path in module units. */
export function qrPath(text: string): { size: number; d: string } {
  const q = qrcode(0, 'M')
  q.addData(text)
  q.make()
  const size = q.getModuleCount()
  let d = ''
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`
  return { size, d }
}

/**
 * The way onto the phone, at the foot of the sidebar instead of a banner over
 * every page: a line that opens a QR code of this address, to scan, open and
 * install. Closing it for good is the same one-time hint the server remembers,
 * so it stays gone on every device.
 */
export default function PhoneHint() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useToast()
  const { data } = useQuery({
    queryKey: ['tips'],
    queryFn: () => api.get<TipsState>('/api/auth/tips'),
    staleTime: Infinity,
  })
  const url = window.location.origin
  const qr = useMemo(() => qrPath(url), [url])
  if (!data || data.dismissed.includes(KEY)) return null

  const dismiss = () => {
    document.getElementById('phone-hint')?.hidePopover()
    qc.setQueryData<TipsState>(['tips'], (d) => ({ dismissed: [...(d?.dismissed ?? []), KEY] }))
    api.post('/api/auth/tips/dismiss', { key: KEY }).catch(() => {})
  }
  const copy = () =>
    navigator.clipboard.writeText(url).then(
      () => toast({ message: t('files.pathCopied') }),
      () => toast({ message: t('files.copyFailed') }),
    )

  return (
    <>
      <button type="button" popoverTarget="phone-hint" className="ws-side-link">
        <Smartphone aria-hidden size="1.25em" className="shrink-0" />
        {t('tips.phone')}
      </button>
      <div id="phone-hint" popover="auto" role="dialog" aria-labelledby="phone-hint-title" className="t-phone-pop">
        <p id="phone-hint-title" className="font-semibold text-t-primary">
          {t('tips.phoneTitle')}
        </p>
        <svg
          viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`}
          role="img"
          aria-label={t('tips.phoneQr')}
          className="mx-auto my-3 block size-44 rounded-md bg-white"
          shapeRendering="crispEdges"
        >
          <path d={qr.d} fill="#000" />
        </svg>
        <p className="text-sm text-pretty text-t-secondary">{t('tips.mobileUi')}</p>
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-border-subtle pt-3">
          <span className="min-w-0 truncate font-mono text-xs text-t-secondary">{url.replace(/^https?:\/\//, '')}</span>
          <Button size="sm" onClick={copy}>
            <Copy aria-hidden size="1em" className="mr-1 inline align-[-0.125em]" />
            {t('tips.copy')}
          </Button>
        </div>
        <button type="button" onClick={dismiss} className="mt-2 min-h-6 text-xs text-t-muted hover:text-t-primary">
          {t('tips.phoneOff')}
        </button>
      </div>
    </>
  )
}
