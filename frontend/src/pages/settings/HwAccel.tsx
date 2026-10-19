import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ExternalLink, Minus, RefreshCw, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Row, Rows } from 'fluid-lycoris'
import { api, type HwCandidate, type HwReport } from '../../api'
import { copyText } from '../../clipboard'
import { useVersion } from '../../hooks'
import { SettingsPanel } from './ui'
import './maintenance.css'

// Hardware transcoding: which encoder the player's transcodes use and, per
// candidate, why it did or did not work, with the compose lines that fix it.
// The server probes on the first transcode; "Test again" runs it on demand.

const NVENC_FIX = 'gpus: all'

const vaapiFix = (gids: (number | undefined)[]) =>
  `devices: ["/dev/dri:/dev/dri"]\ngroup_add: [${(gids.length ? gids : ['<render gid>']).map((g) => `"${g}"`).join(', ')}]`

// a code that means "tried and failed" (worth a warning), against "not there"
const FAILED = new Set(['render_node_no_access', 'vaapi_driver_failed', 'nvenc_failed'])

function CandidateRow({ c }: { c: HwCandidate }) {
  const { t } = useTranslation()
  const name = c.encoder === 'nvenc' ? t('settings.hw.nvenc') : t('settings.hw.vaapi')
  const icon =
    c.code === 'ok' ? (
      <Check aria-hidden size="1.1em" className="text-ok" />
    ) : FAILED.has(c.code) ? (
      <TriangleAlert aria-hidden size="1.1em" className="text-warn" />
    ) : (
      <Minus aria-hidden size="1.1em" className="text-t-muted" />
    )
  const p = c.params
  return (
    <Row
      leading={icon}
      title={
        <>
          {name}
          {c.device && <span className="font-mono text-t-muted"> {c.device.replace('/dev/dri/', '')}</span>}
        </>
      }
      sub={
        <>
          {t(`settings.hw.code.${c.code}`, {
            node: p.node,
            gid: p.gid,
            groups: p.groups?.join(', '),
          })}
          {p.error && (
            <span className="block break-words font-mono text-[length:var(--fs-meta)]">
              {t('settings.hw.ffmpegSaid')} {p.error}
            </span>
          )}
        </>
      }
    />
  )
}

function Fix({ title, hint, code }: { title: string; hint?: string; code: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="hw-fix">
      <p className="sf-note">
        <b>{title}</b>
        {hint && <> {hint}</>}
      </p>
      {/* a scrolling region a keyboard has to reach */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <pre tabIndex={0} role="group" aria-label={title}>
        {code}
      </pre>
      <Button
        size="sm"
        onClick={async () => {
          setCopied(await copyText(code))
          setTimeout(() => setCopied(false), 2000)
        }}
      >
        {copied ? t('settings.hw.copied') : t('settings.hw.copy')}
      </Button>
    </div>
  )
}

export default function HwAccelPanel() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: version } = useVersion()
  const { data } = useQuery<HwReport>({
    queryKey: ['adminHwaccel'],
    queryFn: () => api.get('/api/admin/hwaccel'),
    // a probe that someone else started: follow it until it is done
    refetchInterval: (q) => (q.state.data?.probing ? 2000 : false),
  })
  const probe = useMutation({
    mutationFn: () => api.post<HwReport>('/api/admin/hwaccel/probe'),
    onSuccess: (r) => qc.setQueryData(['adminHwaccel'], r),
  })
  if (!data) return null

  const busy = probe.isPending || data.probing
  const choice = data.choice
  const software = choice?.encoder === 'software'
  const arm = data.issues.some((i) => i.code === 'arch_no_encoder')
  const forced = data.issues.find((i) => i.code === 'forced_mode_failed')

  let headline: string
  let sub: string
  if (!choice) {
    headline = t('settings.hw.notProbed')
    sub = t('settings.hw.notProbedSub')
  } else if (choice.encoder === 'nvenc') {
    headline = t('settings.hw.gpuNvenc')
    sub = t('settings.hw.gpuSub', { height: choice.maxHeight })
  } else if (choice.encoder === 'vaapi') {
    headline = t('settings.hw.gpuVaapi', { device: choice.device?.replace('/dev/dri/', '') })
    sub = t('settings.hw.gpuSub', { height: choice.maxHeight })
  } else if (arm) {
    headline = t('settings.hw.noEncoderHere')
    sub = t('settings.hw.armSub', { height: choice.maxHeight })
  } else {
    headline = t('settings.hw.software', { height: choice.maxHeight })
    sub = t('settings.hw.softwareSub')
  }

  // the fixes a failed or missing candidate calls for: what would make the
  // GPU usable. With a GPU already in use only a blocked node is worth one.
  const gids = [
    ...new Set(
      data.candidates
        .filter((c) => c.code === 'render_node_no_access' && c.params.gid != null)
        .map((c) => c.params.gid),
    ),
  ]
  const needVaapi = data.candidates.some(
    (c) => c.code === 'render_node_no_access' || (software && c.code === 'no_render_nodes'),
  )
  const needNvenc = software && data.candidates.some((c) => c.code === 'no_nvidia_device')
  const repo = version?.repo
    ? `https://github.com/${version.repo}/blob/main/docs/configuration.md#hardware-transcoding`
    : ''

  return (
    <SettingsPanel
      id="hardware"
      title={t('settings.hw.title')}
      desc={t('settings.hw.desc')}
      badge={
        data.modeFromEnv ? (
          <Badge tone="neutral" title={t('settings.hw.modeHint')}>
            {`WEEBSYNC_HWACCEL=${data.mode}`}
          </Badge>
        ) : undefined
      }
    >
      <p className="font-semibold" role="status" aria-live="polite">
        {headline}
      </p>
      <p className="sf-note">{sub}</p>
      {forced && <p className="sf-issue">{t('settings.hw.forcedFailed', { mode: forced.params.mode })}</p>}

      {!arm && data.candidates.length > 0 && choice && (
        <Rows dense>
          {data.candidates.map((c) => (
            <CandidateRow key={`${c.encoder}${c.device ?? ''}`} c={c} />
          ))}
        </Rows>
      )}

      {!arm && needVaapi && (
        <Fix
          title={t('settings.hw.fixVaapi')}
          hint={gids.length ? t('settings.hw.fixVaapiGid') : t('settings.hw.fixVaapiFind')}
          code={vaapiFix(gids)}
        />
      )}
      {!arm && needNvenc && (
        <Fix title={t('settings.hw.fixNvenc')} hint={t('settings.hw.fixNvencHint')} code={NVENC_FIX} />
      )}

      <div className="hw-actions">
        <Button size="sm" disabled={busy} onClick={() => probe.mutate()}>
          <RefreshCw
            aria-hidden
            size="1em"
            className={`mr-1 inline ${busy ? 'animate-spin motion-reduce:animate-none' : ''}`}
          />
          {busy ? t('settings.hw.testing') : t('settings.hw.retest')}
        </Button>
        {data.probedAt && !busy && (
          <span className="text-[length:var(--fs-meta)] text-t-muted">
            {t('settings.hw.testedAt', { when: new Date(data.probedAt).toLocaleString() })}
          </span>
        )}
        {repo && (
          <a className="hw-doc" href={repo} target="_blank" rel="noreferrer">
            {t('settings.hw.docs')}
            <ExternalLink aria-hidden size="0.9em" className="ml-1 inline" />
          </a>
        )}
      </div>
      {probe.isError && (
        <p className="sf-issue" role="alert">
          {(probe.error as Error).message}
        </p>
      )}
    </SettingsPanel>
  )
}
