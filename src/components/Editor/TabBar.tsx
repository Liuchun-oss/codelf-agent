import { useState, useRef, useEffect, type MouseEvent, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore } from '@/stores/editorStore'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu'
import FileIcon from '@/components/common/FileIcon'
import { runActiveFile } from './runFile'
import { isRunnable, BROWSER_LANGUAGES } from './runners'

interface MenuState {
  x: number
  y: number
  path: string
}

export default function TabBar(): JSX.Element | null {
  const {
    tabs,
    activeTabPath,
    setActiveTab,
    requestCloseTab,
    closeOthers,
    closeToRight,
    closeSaved,
    closeAll,
    togglePin,
    moveTab
  } = useEditorStore()

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const check = (): void => {
      setOverflowing(el.scrollWidth > el.clientWidth)
    }
    check()
    const obs = new ResizeObserver(check)
    obs.observe(el)
    return () => obs.disconnect()
  }, [tabs.length])

  useEffect(() => {
    if (tabs.length === 0) {
      setMenu(null)
      setDropdownOpen(false)
    }
  }, [tabs.length])

  if (tabs.length === 0) return null

  const activeTab = tabs.find((t) => t.path === activeTabPath) ?? null
  const canRun =
    activeTab?.kind === 'text' && isRunnable(activeTab.language, activeTab.path)
  const isBrowser = activeTab ? BROWSER_LANGUAGES.has(activeTab.language) : false

  const openMenu = (e: MouseEvent, path: string): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, path })
  }

  const buildItems = (path: string): MenuItem[] => {
    const idx = tabs.findIndex((t) => t.path === path)
    const tab = tabs[idx]
    const hasRight = idx !== -1 && idx < tabs.length - 1
    const hasOthers = tabs.length > 1
    const hasSaved = tabs.some((t) => !t.dirty)
    return [
      { label: '关闭', shortcut: 'Ctrl+W', onClick: () => void requestCloseTab(path) },
      { label: '关闭其他', disabled: !hasOthers, onClick: () => void closeOthers(path) },
      { label: '关闭右侧标签', disabled: !hasRight, onClick: () => void closeToRight(path) },
      { separator: true },
      { label: '关闭已保存', disabled: !hasSaved, onClick: () => void closeSaved() },
      { label: '全部关闭', onClick: () => void closeAll() },
      { separator: true },
      { label: tab?.pinned ? '取消固定' : '固定标签', onClick: () => togglePin(path) },
      { label: '复制路径', disabled: tab?.untitled, onClick: () => void window.lc.clipboardWriteText(path) }
    ]
  }

  const onDrop = (e: DragEvent, targetPath: string): void => {
    e.preventDefault()
    setDragOver(null)
    if (dragPath && dragPath !== targetPath) moveTab(dragPath, targetPath)
    setDragPath(null)
  }

  return (
    <div className="tabbar">
      <div className="tabbar-scroll" ref={scrollRef}>
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={`tab${tab.path === activeTabPath ? ' active' : ''}${tab.dirty ? ' dirty' : ''}${
              tab.pinned ? ' pinned' : ''
            }${dragOver === tab.path ? ' drag-over' : ''}`}
            draggable
            onClick={() => setActiveTab(tab.path)}
            onContextMenu={(e) => openMenu(e, tab.path)}
            onDragStart={() => setDragPath(tab.path)}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(tab.path)
            }}
            onDragLeave={() => setDragOver((p) => (p === tab.path ? null : p))}
            onDrop={(e) => onDrop(e, tab.path)}
            onDragEnd={() => {
              setDragPath(null)
              setDragOver(null)
            }}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                void requestCloseTab(tab.path)
              }
            }}
            title={tab.untitled ? tab.name : tab.path}
          >
            <span className="tab-name">
              <FileIcon name={tab.name} />
              {tab.name}
            </span>
            <span className="tab-trailing">
              {tab.pinned && (
                <span
                  className="pin"
                  title="取消固定"
                  onClick={(e) => {
                    e.stopPropagation()
                    togglePin(tab.path)
                  }}
                >
                  📌
                </span>
              )}
              {tab.dirty && <span className="dot" title="未保存" />}
              <span
                className="close"
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation()
                  void requestCloseTab(tab.path)
                }}
              >
                ×
              </span>
            </span>
          </div>
        ))}
      </div>

      {overflowing && (
        <div
          ref={moreRef}
          className="tabbar-more"
          title="更多标签"
          onClick={() => setDropdownOpen((v) => !v)}
        >
          ›
        </div>
      )}

      {canRun && (
        <button
          className="tabbar-run-btn"
          title={isBrowser ? '在默认浏览器中打开' : '运行文件'}
          aria-label={isBrowser ? '在默认浏览器中打开' : '运行文件'}
          onClick={() => void runActiveFile()}
        >
          {isBrowser ? (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
              <circle cx="8" cy="8" r="6.2" />
              <path d="M1.8 8h12.4M8 1.8c1.8 1.7 2.8 3.9 2.8 6.2S9.8 12.5 8 14.2C6.2 12.5 5.2 10.3 5.2 8S6.2 3.5 8 1.8z" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M3.5 2.5v11l9-5.5-9-5.5z" />
            </svg>
          )}
        </button>
      )}

      {dropdownOpen && createPortal(
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9999 }}
            onClick={() => setDropdownOpen(false)}
          />
          <div
            className="tabbar-dropdown"
            style={{
              position: 'fixed',
              top: moreRef.current ? moreRef.current.getBoundingClientRect().bottom + 2 : 37,
              left: moreRef.current
                ? Math.max(0, moreRef.current.getBoundingClientRect().right - 220)
                : undefined,
              width: 220,
              zIndex: 10000
            }}
          >
            {tabs.map((tab) => (
              <div
                key={tab.path}
                className={`tabbar-dropdown-item${tab.path === activeTabPath ? ' active' : ''}`}
                onClick={() => {
                  setActiveTab(tab.path)
                  setDropdownOpen(false)
                }}
                title={tab.path}
              >
                <FileIcon name={tab.name} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.name}</span>
                <span
                  className="close"
                  onClick={(e) => {
                    e.stopPropagation()
                    void requestCloseTab(tab.path)
                  }}
                >
                  ×
                </span>
              </div>
            ))}
          </div>
        </>,
        document.body
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildItems(menu.path)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
