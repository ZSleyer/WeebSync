import { useId, type InputHTMLAttributes, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Input, SettingsField, Switch, Textarea } from 'fluid-lycoris'
import './settings.css'

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

// The building blocks every settings section uses: an unboxed panel with a
// heading, and one field per setting (label, ENV chip, control, hint, what
// is wrong with it). The panel heading is an h3: the layout carries the h1
// and each section's h2.

export interface SettingsPanelProps {
  title?: ReactNode
  /** beside the title: a status chip */
  badge?: ReactNode
  /** the quiet line under the title */
  desc?: ReactNode
  /** a deep link target (#id) */
  id?: string
  /** an irreversible action: the title in the error colour */
  danger?: boolean
  children?: ReactNode
  className?: string
}

export function SettingsPanel({ title, badge, desc, id, danger, children, className }: SettingsPanelProps) {
  const hid = useId()
  return (
    <section
      id={id}
      className={cx('set-p', danger && 'danger', className)}
      aria-labelledby={title !== undefined ? hid : undefined}
    >
      {title !== undefined && (
        <h3 id={hid}>
          {title}
          {badge}
        </h3>
      )}
      {desc !== undefined && <p className="set-desc">{desc}</p>}
      {children}
    </section>
  )
}

/** The chip after a label whose value an environment variable forces. */
export function EnvChip({ show }: { show: boolean }) {
  const { t } = useTranslation()
  if (!show) return null
  return (
    <span className="set-env" title={t('settings.envLockedHint')}>
      ENV<span className="sr-only">{`: ${t('settings.envLockedHint')}`}</span>
    </span>
  )
}

/** The line under a field when its value is wrong. */
function Issue({ id, msg }: { id: string; msg?: string }) {
  const { t } = useTranslation()
  if (!msg) return null
  return (
    <p id={id} className="sf-issue">
      {t('settings.fieldIssue', { msg })}
    </p>
  )
}

const describedBy = (...ids: (string | false | undefined)[]) => ids.filter(Boolean).join(' ') || undefined

interface FieldBase {
  label: ReactNode
  hint?: ReactNode
  /** the value comes from an environment variable: read only, ENV chip */
  env?: boolean
  /** what is wrong with the stored or refused value */
  issue?: string
  className?: string
}

export interface TextSettingProps
  extends FieldBase, Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'className' | 'onChange'> {
  value: string | number
  onChange: (value: string) => void
  mono?: boolean
  /** a short number field */
  narrow?: boolean
}

/** One text, URL or number setting: label, ENV chip, field, hint. */
export function TextSetting({
  label,
  hint,
  env,
  issue,
  className,
  value,
  onChange,
  mono,
  narrow,
  ...input
}: TextSettingProps) {
  const id = useId()
  return (
    <SettingsField
      label={label}
      htmlFor={id}
      hint={hint}
      hintId={id + 'h'}
      badge={<EnvChip show={!!env} />}
      className={className}
    >
      <Input
        id={id}
        {...input}
        value={value}
        readOnly={env || input.readOnly}
        aria-invalid={issue ? true : undefined}
        aria-describedby={describedBy(hint !== undefined && id + 'h', issue && id + 'i')}
        className={cx(mono && 'font-mono', narrow && 'sf-num')}
        onChange={(e) => onChange(e.target.value)}
      />
      <Issue id={id + 'i'} msg={issue} />
    </SettingsField>
  )
}

export interface ListSettingProps extends FieldBase {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
}

/** A list, one entry per line. */
export function ListSetting({
  label,
  hint,
  env,
  issue,
  className,
  value,
  onChange,
  placeholder,
  rows,
}: ListSettingProps) {
  const { t } = useTranslation()
  const id = useId()
  const lines = value.split('\n').length
  return (
    <SettingsField
      label={label}
      htmlFor={id}
      hint={
        <>
          {t('settings.onePerLine')}
          {hint !== undefined && <> {hint}</>}
        </>
      }
      hintId={id + 'h'}
      badge={<EnvChip show={!!env} />}
      className={className}
    >
      <Textarea
        id={id}
        className="font-mono"
        rows={rows ?? Math.min(8, Math.max(2, lines))}
        value={value}
        placeholder={placeholder}
        readOnly={env}
        spellCheck={false}
        aria-invalid={issue ? true : undefined}
        aria-describedby={describedBy(id + 'h', issue && id + 'i')}
        onChange={(e) => onChange(e.target.value)}
      />
      <Issue id={id + 'i'} msg={issue} />
    </SettingsField>
  )
}

export interface SecretSettingProps extends FieldBase {
  /** whether a value is stored */
  stored: boolean
  value: string
  onChange: (value: string) => void
}

/**
 * A write-only secret: an empty field keeps the stored one, "-" clears it.
 * The word beside it says whether one is stored.
 */
export function SecretSetting({ label, hint, env, issue, className, stored, value, onChange }: SecretSettingProps) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <SettingsField
      label={label}
      htmlFor={id}
      hint={hint}
      hintId={id + 'h'}
      badge={<EnvChip show={!!env} />}
      className={className}
    >
      <div className="sec-row">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          className="font-mono"
          placeholder={stored ? t('settings.secretSet') : t('settings.secretUnset')}
          value={value}
          readOnly={env}
          aria-invalid={issue ? true : undefined}
          aria-describedby={describedBy(id + 's', hint !== undefined && id + 'h', issue && id + 'i')}
          onChange={(e) => onChange(e.target.value)}
        />
        <span id={id + 's'} className={cx('sec-st', stored && 'ok')}>
          {stored ? t('settings.secretStored') : t('settings.secretMissing')}
        </span>
      </div>
      <Issue id={id + 'i'} msg={issue} />
    </SettingsField>
  )
}

export interface SwitchSettingProps extends FieldBase {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

/** An on/off setting: label and hint at the left, the switch at the right. */
export function SwitchSetting({ label, hint, env, issue, className, checked, onChange, disabled }: SwitchSettingProps) {
  const id = useId()
  return (
    <SettingsField
      row
      label={label}
      htmlFor={id}
      hint={hint}
      hintId={id + 'h'}
      badge={<EnvChip show={!!env} />}
      className={className}
    >
      <Switch
        id={id}
        checked={checked}
        disabled={disabled || env}
        aria-describedby={describedBy(hint !== undefined && id + 'h', issue && id + 'i')}
        onChange={(e) => onChange(e.target.checked)}
      />
      <Issue id={id + 'i'} msg={issue} />
    </SettingsField>
  )
}
