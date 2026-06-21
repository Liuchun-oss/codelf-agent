import { useEffect, useRef, useState } from 'react'
import { useDialogStore } from '@/stores/dialogStore'
import AnimatedOverlay from '@/components/common/AnimatedOverlay'

function PromptDialog(): JSX.Element | null {
  const active = useDialogStore((s) => s.active)
  const close = useDialogStore((s) => s._close)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [snap, setSnap] = useState<Extract<NonNullable<typeof active>, { kind: 'prompt' }> | null>(
    null
  )

  const open = active?.kind === 'prompt'

  useEffect(() => {
    if (active?.kind === 'prompt') setSnap(active)
  }, [active])

  useEffect(() => {
    if (active?.kind !== 'prompt') return
    const opts = active.options
    setValue(opts.defaultValue ?? '')
    setError(null)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      const end = opts.selectionEnd ?? (opts.defaultValue?.length ?? 0)
      el.setSelectionRange(0, end)
    })
  }, [open, active])

  if (!snap) return null
  const opts = snap.options

  const submit = (): void => {
    const err = opts.validate?.(value) ?? null
    if (err) {
      setError(err)
      return
    }
    snap.resolve(value.trim())
    close()
  }

  const cancel = (): void => {
    snap.resolve(null)
    close()
  }

  return (
    <AnimatedOverlay
      open={open}
      onClose={cancel}
      onExited={() => setSnap(null)}
      clickOverlayToClose
      overlayClassName="modal-overlay"
      panelClassName="modal"
    >
      <div className="modal-title">{opts.title}</div>
      <div className="modal-body">
        <label className="modal-label">{opts.label}</label>
        <input
          ref={inputRef}
          className={`modal-input${error ? ' error' : ''}`}
          value={value}
          placeholder={opts.placeholder}
          onChange={(e) => {
            setValue(e.target.value)
            setError(opts.validate?.(e.target.value) ?? null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
        />
        {error && <div className="modal-error">{error}</div>}
      </div>
      <div className="modal-footer">
        <button className="btn-secondary" onClick={cancel}>
          取消
        </button>
        <button className="btn" disabled={!!error} onClick={submit}>
          {opts.confirmText ?? '确定'}
        </button>
      </div>
    </AnimatedOverlay>
  )
}

function ConfirmDialog(): JSX.Element | null {
  const active = useDialogStore((s) => s.active)
  const close = useDialogStore((s) => s._close)
  const okRef = useRef<HTMLButtonElement>(null)
  const [snap, setSnap] = useState<Extract<NonNullable<typeof active>, { kind: 'confirm' }> | null>(
    null
  )

  const open = active?.kind === 'confirm'

  useEffect(() => {
    if (active?.kind === 'confirm') setSnap(active)
  }, [active])

  useEffect(() => {
    if (open) requestAnimationFrame(() => okRef.current?.focus())
  }, [open])

  if (!snap) return null
  const opts = snap.options

  const done = (v: boolean): void => {
    snap.resolve(v)
    close()
  }

  return (
    <AnimatedOverlay
      open={open}
      onClose={() => done(false)}
      onExited={() => setSnap(null)}
      clickOverlayToClose
      overlayClassName="modal-overlay"
      panelClassName="modal"
    >
      <div
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') done(false)
          if (e.key === 'Enter') done(true)
        }}
      >
        <div className="modal-title">{opts.title}</div>
        <div className="modal-body">
          <div className="modal-message">{opts.message}</div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={() => done(false)}>
            {opts.cancelText ?? '取消'}
          </button>
          <button
            ref={okRef}
            className={opts.danger ? 'btn btn-danger' : 'btn'}
            onClick={() => done(true)}
          >
            {opts.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </AnimatedOverlay>
  )
}

function ChooseDialog(): JSX.Element | null {
  const active = useDialogStore((s) => s.active)
  const close = useDialogStore((s) => s._close)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const [snap, setSnap] = useState<Extract<NonNullable<typeof active>, { kind: 'choose' }> | null>(
    null
  )

  const open = active?.kind === 'choose'

  useEffect(() => {
    if (active?.kind === 'choose') setSnap(active)
  }, [active])

  useEffect(() => {
    if (open) requestAnimationFrame(() => primaryRef.current?.focus())
  }, [open])

  if (!snap) return null
  const opts = snap.options
  const primaryIdx = opts.buttons.findIndex((b) => b.primary)

  const done = (key: string | null): void => {
    snap.resolve(key)
    close()
  }

  return (
    <AnimatedOverlay
      open={open}
      onClose={() => done(null)}
      onExited={() => setSnap(null)}
      clickOverlayToClose
      overlayClassName="modal-overlay"
      panelClassName="modal"
    >
      <div
        onKeyDown={(e) => {
          if (e.key === 'Escape') done(null)
        }}
      >
        <div className="modal-title">{opts.title}</div>
        <div className="modal-body">
          <div className="modal-message">{opts.message}</div>
        </div>
        <div className="modal-footer">
          {opts.buttons.map((b, i) => (
            <button
              key={b.key}
              ref={i === primaryIdx ? primaryRef : undefined}
              className={b.danger ? 'btn btn-danger' : b.primary ? 'btn' : 'btn-secondary'}
              onClick={() => done(b.key)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </AnimatedOverlay>
  )
}

function PickDialog(): JSX.Element | null {
  const active = useDialogStore((s) => s.active)
  const close = useDialogStore((s) => s._close)
  const firstRef = useRef<HTMLButtonElement>(null)
  const [snap, setSnap] = useState<Extract<NonNullable<typeof active>, { kind: 'pick' }> | null>(
    null
  )

  const open = active?.kind === 'pick'

  useEffect(() => {
    if (active?.kind === 'pick') setSnap(active)
  }, [active])

  useEffect(() => {
    if (open) requestAnimationFrame(() => firstRef.current?.focus())
  }, [open])

  if (!snap) return null
  const opts = snap.options

  const done = (key: string | null): void => {
    snap.resolve(key)
    close()
  }

  return (
    <AnimatedOverlay
      open={open}
      onClose={() => done(null)}
      onExited={() => setSnap(null)}
      clickOverlayToClose
      overlayClassName="modal-overlay"
      panelClassName="modal"
    >
      <div
        onKeyDown={(e) => {
          if (e.key === 'Escape') done(null)
        }}
      >
        <div className="modal-title">{opts.title}</div>
        <div className="modal-body">
          {opts.message && <div className="modal-message">{opts.message}</div>}
          <div className="pick-list">
            {opts.items.map((item, i) => (
              <button
                key={item.key}
                ref={i === 0 ? firstRef : undefined}
                className="pick-item"
                onClick={() => done(item.key)}
              >
                <span className="pick-item-label">{item.label}</span>
                {item.detail && <span className="pick-item-detail">{item.detail}</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </AnimatedOverlay>
  )
}

export default function Dialogs(): JSX.Element {
  return (
    <>
      <PromptDialog />
      <ConfirmDialog />
      <ChooseDialog />
      <PickDialog />
    </>
  )
}
