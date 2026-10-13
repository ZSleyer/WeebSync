import type { InputHTMLAttributes, ReactNode } from 'react'

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'> {
  /** visible text beside the switch; without it pass aria-label or wire a label via id */
  label?: ReactNode
  labelClassName?: string
}

/**
 * An on/off switch: a native checkbox with the switch role, so it keeps the
 * form behaviour and the keyboard. The knob slides on the calm spring and
 * the track fills with the accent when it is on.
 */
export function Switch({ label, labelClassName, className, ...rest }: SwitchProps) {
  const input = <input type="checkbox" role="switch" {...rest} className={cx('t-switch', className)} />
  if (label === undefined) return input
  return (
    <label className={cx('t-switch-label', labelClassName)}>
      <span className="min-w-0 flex-1">{label}</span>
      {input}
    </label>
  )
}

export interface SettingsFieldProps {
  label: ReactNode
  /** the quiet line under the label */
  hint?: ReactNode
  /** the id of the control, so the label names it */
  htmlFor?: string
  /** beside the label: an ENV chip, a status */
  badge?: ReactNode
  /**
   * row: label and hint at the left, a compact control (a switch, a small
   * select) at the right. Without it the control sits under the label.
   */
  row?: boolean
  children: ReactNode
  className?: string
}

/**
 * One setting: its label, an optional chip beside it, a quiet hint, and the
 * control. A row for switches, stacked for fields.
 */
export function SettingsField({ label, hint, htmlFor, badge, row, children, className }: SettingsFieldProps) {
  return (
    <div className={cx('t-sf', row && 't-sf--row', className)}>
      <div className="t-sf-l">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {badge}
      </div>
      {children}
      {hint !== undefined && <p className="t-sf-h">{hint}</p>}
    </div>
  )
}
