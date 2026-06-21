import { useEffect, useRef } from 'react'
import { useInlineEditStore } from '@/stores/inlineEditStore'
import {
  runInlineEdit,
  acceptInlineEdit,
  rejectInlineEdit
} from './inlineEditController'

export default function InlineEditWidget(): JSX.Element | null {
  const { active, status, instruction, error, top, left, width, setInstruction } =
    useInlineEditStore()
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (active && status === 'input') {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [active, status])

  
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        rejectInlineEdit()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])

  if (!active) return null

  const submit = (): void => {
    const text = instruction.trim()
    if (!text) return
    void runInlineEdit(text)
  }

  return (
    <div
      className="inline-edit-widget"
      style={{ top, left, width }}
      onClick={(e) => e.stopPropagation()}
    >
      {status === 'diff' ? (
        <div className="inline-edit-actions-bar">
          <span className="inline-edit-hint">已生成修改，查看下方 diff</span>
          <div className="inline-edit-btns">
            <button className="inline-edit-btn accept" onClick={() => acceptInlineEdit()}>
              接受 <kbd>Ctrl+↵</kbd>
            </button>
            <button className="inline-edit-btn reject" onClick={() => rejectInlineEdit()}>
              拒绝 <kbd>Esc</kbd>
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="inline-edit-input-row">
            <span className="inline-edit-spark">✦</span>
            <textarea
              ref={inputRef}
              className="inline-edit-input"
              placeholder="描述要对选中代码做的修改…"
              value={instruction}
              disabled={status === 'loading'}
              rows={1}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            <button
              className="inline-edit-close"
              title="关闭 (Esc)"
              aria-label="关闭"
              onClick={() => rejectInlineEdit()}
            >
              ✕
            </button>
          </div>
          <div className="inline-edit-footer">
            {status === 'loading' ? (
              <span className="inline-edit-status">
                <span className="inline-edit-spinner" /> 生成中…
              </span>
            ) : status === 'error' ? (
              <span className="inline-edit-error">{error}</span>
            ) : (
              <span className="inline-edit-hint">
                <kbd>↵</kbd> 生成 · <kbd>Esc</kbd> 取消
              </span>
            )}
            <div className="inline-edit-btns">
              {status === 'loading' ? (
                <button className="inline-edit-btn reject" onClick={() => rejectInlineEdit()}>
                  停止
                </button>
              ) : (
                <button
                  className="inline-edit-btn accept"
                  disabled={!instruction.trim()}
                  onClick={submit}
                >
                  生成
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
