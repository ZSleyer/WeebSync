import { useState } from 'react'
import { Segmented } from '@weebsync/design-system'

// One of a few views: the pressed option is the primary button. Icon-only
// options carry an aria-label.
export const Views = () => {
  const [view, setView] = useState<'list' | 'calendar'>('list')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  return (
    <div className="flex flex-col gap-3" style={{ maxWidth: 380 }}>
      <Segmented
        aria-label="Ansicht"
        value={view}
        onChange={setView}
        options={[
          { value: 'list', label: '☰', 'aria-label': 'Liste' },
          { value: 'calendar', label: '▦', 'aria-label': 'Kalender' },
        ]}
      />
      <Segmented
        aria-label="Modus"
        size="md"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'login', label: 'Anmelden' },
          { value: 'register', label: 'Registrieren' },
        ]}
      />
    </div>
  )
}
