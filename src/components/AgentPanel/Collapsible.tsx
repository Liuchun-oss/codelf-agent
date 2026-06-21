import { type ReactNode } from 'react'

interface Props {
  open: boolean
  children: ReactNode
  className?: string
}

export default function Collapsible({ open, children, className }: Props): JSX.Element {
  return (
    <div
      className={`collapsible-wrapper${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
    >
      <div className="collapsible-inner">{children}</div>
    </div>
  )
}
