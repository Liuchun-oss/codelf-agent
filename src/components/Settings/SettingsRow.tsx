import type { ReactNode } from 'react'

export function SettingsGroup({
  label,
  children
}: {
  label?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="settings-group">
      {label && <div className="settings-group-label">{label}</div>}
      {children}
    </div>
  )
}

export function SettingsRow({
  title,
  description,
  control,
  stacked
}: {
  title: string
  description?: string
  control: ReactNode
  stacked?: boolean
}): JSX.Element {
  return (
    <div className={`settings-row${stacked ? ' stacked' : ''}`}>
      <div className="settings-row-text">
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </div>
      <div className="settings-row-control">{control}</div>
    </div>
  )
}

export function SettingsSwitch({
  checked,
  disabled,
  onChange,
  id
}: {
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  id?: string
}): JSX.Element {
  return (
    <label className="settings-switch" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="settings-switch-track" />
    </label>
  )
}
