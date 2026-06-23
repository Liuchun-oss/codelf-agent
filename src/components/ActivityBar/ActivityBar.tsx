import { useLayoutEffect, useRef, useState } from 'react'
import { useUiStore } from '@/stores/uiStore'
import { useEditorStore } from '@/stores/editorStore'

type SidebarViewId = 'explorer' | 'search' | 'scm' | 'knowledge'


export default function ActivityBar(): JSX.Element {
  const view = useUiStore((s) => s.sidebarView)
  const show = useUiStore((s) => s.showFileTree)
  const showView = useUiStore((s) => s.showSidebarView)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [indicator, setIndicator] = useState({ y: 0, h: 40, visible: false })

  const activeIndex = !show
    ? -1
    : view === 'explorer'
      ? 0
      : view === 'search'
        ? 1
        : view === 'scm'
          ? 2
          : view === 'knowledge'
            ? 3
            : -1

  useLayoutEffect(() => {
    if (activeIndex === -1) {
      setIndicator((s) => ({ ...s, visible: false }))
      return
    }
    const btn = itemRefs.current[activeIndex]
    if (!btn) return
    setIndicator({ y: btn.offsetTop, h: btn.offsetHeight, visible: true })
  }, [activeIndex])

  const isActive = (v: SidebarViewId): boolean => show && view === v

  const setAppView = useUiStore((s) => s.setAppView)

  return (
    <div className="activity-bar">
      <div
        className={`activity-indicator${indicator.visible ? ' is-visible' : ''}`}
        style={{ transform: `translateY(${indicator.y}px)`, height: indicator.h }}
        aria-hidden
      />
      {/* 无自定义标题栏的平台兜底入口；有 titlebar 视图切换器时收敛，避免双入口 */}
      {!window.lc.usesCustomTitleBar && (
        <button
          className="activity-item"
          title="首页"
          onClick={() => setAppView('home')}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M4 11l8-7 8 7v8.5A1.5 1.5 0 0 1 18.5 21h-13A1.5 1.5 0 0 1 4 19.5z" />
            <path d="M9.5 21v-6h5v6" />
          </svg>
        </button>
      )}
      <button
        ref={(el) => {
          itemRefs.current[0] = el
        }}
        className={`activity-item${isActive('explorer') ? ' active' : ''}`}
        title="资源管理器 (Ctrl+Shift+E)"
        onClick={() => showView('explorer')}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h4l2 2.2h7A1.5 1.5 0 0 1 19 7.7v9.8A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z" />
        </svg>
      </button>
      <button
        ref={(el) => {
          itemRefs.current[1] = el
        }}
        className={`activity-item${isActive('search') ? ' active' : ''}`}
        title="搜索 (Ctrl+Shift+F)"
        onClick={() => showView('search')}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="M20 20l-5-5" strokeLinecap="round" />
        </svg>
      </button>
      <button
        ref={(el) => {
          itemRefs.current[2] = el
        }}
        className={`activity-item${isActive('scm') ? ' active' : ''}`}
        title="源代码管理 (Ctrl+Shift+G)"
        onClick={() => showView('scm')}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="6" cy="6" r="2.6" />
          <circle cx="6" cy="18" r="2.6" />
          <circle cx="18" cy="8" r="2.6" />
          <path d="M6 8.6v6.8M18 10.6c0 4.2-4.2 3.4-9 3.4" strokeLinecap="round" />
        </svg>
      </button>
      <button
        ref={(el) => {
          itemRefs.current[3] = el
        }}
        className={`activity-item${isActive('knowledge') ? ' active' : ''}`}
        title="知识库 (Ctrl+Shift+K)"
        onClick={() => showView('knowledge')}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5v15A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5z" />
          <path d="M8 7h8M8 11h8M8 15h5" strokeLinecap="round" />
        </svg>
      </button>
      <button
        className="activity-item"
        title="内置浏览器"
        onClick={() => useEditorStore.getState().openBrowser()}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.6 2.4 4 5.6 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.6-4-9s1.4-6.6 4-9z" />
        </svg>
      </button>
    </div>
  )
}
