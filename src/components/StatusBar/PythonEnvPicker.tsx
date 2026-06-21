import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePythonStore } from '@/stores/pythonStore'
import type { PythonEnv } from '@shared/pythonTypes'

const KIND_TAG: Record<PythonEnv['kind'], string> = {
  global: '全局',
  conda: 'Conda',
  venv: 'venv',
  pyenv: 'pyenv',
  unknown: ''
}

export default function PythonEnvPicker(): JSX.Element {
  const { envs, selected, loading, init, discover, select, browse } = usePythonStore()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const anchorRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const closedAtRef = useRef(0)
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null)

  useEffect(() => {
    void init().then(() => {
      
      void discover()
    })
  }, [init, discover])

  const openPicker = (): void => {
    
    if (open || Date.now() - closedAtRef.current < 250) {
      setOpen(false)
      return
    }
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) {
      const width = Math.max(420, Math.min(560, window.innerWidth - 40))
      let left = rect.left
      if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12
      setPos({ left: Math.max(12, left), bottom: window.innerHeight - rect.top + 6, width })
    }
    setFilter('')
    setOpen(true)
    
    void discover()
  }

  const closePicker = (): void => {
    closedAtRef.current = Date.now()
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closePicker()
    }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (pickerRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      closePicker()
    }
    window.addEventListener('keydown', onKey)
    
    setTimeout(() => window.addEventListener('mousedown', onDown, true), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [open])

  const choose = async (env: PythonEnv): Promise<void> => {
    closePicker()
    await select(env)
  }

  const onBrowse = async (): Promise<void> => {
    closePicker()
    await browse()
  }

  const list = envs.filter((e) => {
    if (!filter.trim()) return true
    const q = filter.toLowerCase()
    return e.label.toLowerCase().includes(q) || e.executable.toLowerCase().includes(q)
  })

  return (
    <>
      <div
        ref={anchorRef}
        className="seg clickable python-env-seg"
        title={selected ? `Python 解释器：${selected.executable}` : '选择 Python 解释器'}
        onClick={openPicker}
      >
        <span className="python-env-icon" aria-hidden>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M11.9 2c-2 0-3.5.4-3.5 2.3v1.6h3.6v.6H5.6C3.6 6.5 3 8 3 10s.6 3.6 2.6 3.6h1.2v-1.9c0-1.8 1.5-3.3 3.4-3.3h3.5c1.6 0 2.9-1.3 2.9-2.9V4.3C16.9 2.6 15.6 2 13.7 2zm-2 1.3a.7.7 0 110 1.4.7.7 0 010-1.4z" />
            <path d="M12.1 22c2 0 3.5-.4 3.5-2.3v-1.6H12v-.6h6.4c2 0 2.6-1.5 2.6-3.5s-.6-3.6-2.6-3.6h-1.2v1.9c0 1.8-1.5 3.3-3.4 3.3h-3.5c-1.6 0-2.9 1.3-2.9 2.9v2.9c0 1.7 1.3 2.3 3.2 2.3zm2-1.3a.7.7 0 110-1.4.7.7 0 010 1.4z" opacity="0.85" />
          </svg>
        </span>
        {selected ? selected.label : '选择解释器'}
      </div>

      {open && pos
        ? createPortal(
            <>
              <div
                ref={pickerRef}
                className="python-picker"
                style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}
                role="dialog"
                aria-label="选择 Python 环境"
              >
                <input
                  className="python-picker-input"
                  placeholder="选择 Python 环境"
                  value={filter}
                  autoFocus
                  onChange={(e) => setFilter(e.target.value)}
                />
                <div className="python-picker-list">
                  <div
                    className="python-picker-row python-picker-browse"
                    onClick={() => void onBrowse()}
                  >
                    <span className="python-picker-browse-icon" aria-hidden>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M1.5 3.5A1.5 1.5 0 013 2h3l1.5 1.5H13A1.5 1.5 0 0114.5 5v6A1.5 1.5 0 0113 12.5H3A1.5 1.5 0 011.5 11V3.5z" />
                      </svg>
                    </span>
                    <span className="python-picker-label">浏览…</span>
                    <span className="python-picker-path">手动选择 python 解释器路径</span>
                  </div>
                  {loading && envs.length === 0 ? (
                    <div className="python-picker-empty">正在查找解释器…</div>
                  ) : list.length === 0 ? (
                    <div className="python-picker-empty">未找到 Python 解释器</div>
                  ) : (
                    list.map((env) => {
                      const isSel = selected?.id === env.id
                      return (
                        <div
                          key={env.id}
                          className={`python-picker-row${isSel ? ' selected' : ''}`}
                          onClick={() => void choose(env)}
                        >
                          <span className="python-picker-label">{env.label}</span>
                          <span className="python-picker-path">{env.executable}</span>
                          {env.recommended ? (
                            <span className="python-picker-tag rec">推荐</span>
                          ) : KIND_TAG[env.kind] ? (
                            <span className="python-picker-tag">{KIND_TAG[env.kind]}</span>
                          ) : null}
                        </div>
                      )
                    })
                  )}
                </div>
                {loading && envs.length > 0 ? (
                  <div className="python-picker-footer">正在刷新…</div>
                ) : null}
              </div>
            </>,
            document.body
          )
        : null}
    </>
  )
}
