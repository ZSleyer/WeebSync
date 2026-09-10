import { Progress } from '@weebsync/design-system'

/** The download queue's bar: a full-height one for the transfer in progress, the thin one for the rows behind it. */
export const Sizes = () => (
  <div style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
    <Progress value={42} label="Fortschritt Frieren S01E12" />
    <Progress value={42} size="sm" label="Fortschritt Frieren S01E13" />
  </div>
)

/** Stripes move while bytes flow; a paused row keeps the plain bar. */
export const Active = () => (
  <div style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
    <Progress value={67} active label="Fortschritt Frieren S01E12" />
    <Progress value={67} label="Fortschritt Frieren S01E12 (pausiert)" />
  </div>
)

/** A meter, not a download: a disk close to full says so in the warn tone. */
export const Tones = () => (
  <div style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
    <Progress value={35} tone="ok" label="Speicher, 35 % belegt" />
    <Progress value={88} tone="warn" label="Speicher, 88 % belegt" />
    <Progress value={97} tone="err" label="Speicher, 97 % belegt" />
  </div>
)

export const LightMode = () => (
  <div data-theme="light" style={{ background: 'var(--bg-primary)', padding: 12, maxWidth: 420, display: 'grid', gap: 12 }}>
    <Progress value={42} active label="Fortschritt Frieren S01E12" />
    <Progress value={88} tone="warn" size="sm" label="Speicher, 88 % belegt" />
  </div>
)
