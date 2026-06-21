import { useEffect, useRef, useState } from 'react'
import type { Workspace } from '@/types'
import { getRecentWorkspaces } from '@/utils/session'

interface CwdPickerProps {
  value: Workspace | null
  onChange: (ws: Workspace | null) => void
}

/** 目录选择器：最近工作区 + 浏览 + 纯对话 */
export default function CwdPicker({ value, onChange }: CwdPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState<Workspace[]>([])
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) setRecent(getRecentWorkspaces())
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const browse = async (): Promise<void> => {
    const ws = await window.lc.openFolder()
    if (ws) {
      onChange(ws)
      setOpen(false)
    }
  }

  return (
    <div className="cwd-picker" ref={rootRef}>
      <button
        type="button"
        className="cwd-picker-trigger"
        title={value ? value.path : '请选择工作区'}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h4l2 2.2h7A1.5 1.5 0 0 1 19 7.7v9.8A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z" />
        </svg>
        <span className="cwd-picker-label">{value ? value.name : '请选择工作区'}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 9l6 6 6-6" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="cwd-picker-menu">
          {recent.length > 0 && (
            <>
              <div className="cwd-picker-group">最近目录</div>
              {recent.map((ws) => (
                <button
                  key={ws.path}
                  type="button"
                  className={`cwd-picker-item${value?.path === ws.path ? ' active' : ''}`}
                  title={ws.path}
                  onClick={() => {
                    onChange(ws)
                    setOpen(false)
                  }}
                >
                  <span className="cwd-picker-item-name">{ws.name}</span>
                  <span className="cwd-picker-item-path">{ws.path}</span>
                </button>
              ))}
              <div className="cwd-picker-sep" />
            </>
          )}
          <button type="button" className="cwd-picker-item" onClick={() => void browse()}>
            浏览…
          </button>
          <button
            type="button"
            className={`cwd-picker-item${value === null ? ' active' : ''}`}
            onClick={() => {
              onChange(null)
              setOpen(false)
            }}
          >
            纯对话（不设置目录）
          </button>
        </div>
      )}
    </div>
  )
}
