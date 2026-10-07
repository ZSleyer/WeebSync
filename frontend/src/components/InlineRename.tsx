import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

/** what is being renamed in place, and where the outcome goes */
export interface Renaming {
  path: string
  /** the new name, or null when it was abandoned */
  onDone: (name: string | null) => void
}

/**
 * A name turned into its own input where it stands, instead of a dialog with
 * one field. The part before the extension is selected, so typing replaces
 * the name and keeps the type. Enter or leaving the field saves, Escape
 * abandons - without closing a dialog the row may sit in.
 */
export function InlineRename({
  name,
  onDone,
  className = '',
}: {
  name: string
  onDone: Renaming['onDone']
  className?: string
}) {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  const settled = useRef(false)
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    const dot = name.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : name.length)
  }, [name])
  const done = (v: string | null) => {
    if (settled.current) return
    settled.current = true
    onDone(v === null || v.trim() === '' || v.trim() === name ? null : v.trim())
  }
  return (
    <input
      ref={input}
      defaultValue={name}
      aria-label={t('local.renameField', { name })}
      className={`t-input t-input--sm min-w-0 flex-1 ${className}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          done(e.currentTarget.value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          done(null)
        }
      }}
      onBlur={(e) => done(e.currentTarget.value)}
    />
  )
}
