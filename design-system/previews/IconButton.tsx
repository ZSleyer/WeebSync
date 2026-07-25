import { IconButton } from '@weebsync/design-system'

const Question = () => (
  <span
    style={{
      display: 'inline-flex',
      width: '1rem',
      height: '1rem',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: '9999px',
      border: '1px solid var(--border-subtle)',
      fontSize: 10,
      lineHeight: 1,
      color: 'var(--text-secondary)',
    }}
  >
    ?
  </span>
)

export const Help = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Dub-Sprache</span>
    <IconButton aria-label="Hilfe zur Dub-Sprache">
      <Question />
    </IconButton>
  </div>
)

export const Close = () => (
  <IconButton aria-label="Schließen">
    <span style={{ fontSize: 14, lineHeight: 1, color: 'var(--text-secondary)' }}>×</span>
  </IconButton>
)
