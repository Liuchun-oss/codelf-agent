import { useCallback, useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'

/** Normalize a user-typed address into a loadable URL (or a search query). */
export function normalizeAddress(input: string): string {
  const raw = input.trim()
  if (!raw) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(raw)) return `http://${raw}`
  // Looks like a domain (has a dot, no spaces) → assume https.
  if (/^[^\s/]+\.[^\s/]+/.test(raw) && !raw.includes(' ')) return `https://${raw}`
  // Otherwise treat as a web search.
  return `https://www.bing.com/search?q=${encodeURIComponent(raw)}`
}

interface Props {
  initialUrl: string
  /** Reports navigation so the host (tab) can persist the current URL/title. */
  onUrlChange?: (url: string) => void
  onTitleChange?: (title: string) => void
}

/**
 * Reusable interactive browser surface built on Electron's <webview> tag.
 * Renders a navigation toolbar (back / forward / reload / address bar) above a
 * live, fully interactive embedded web page. Used both as an IDE editor tab and
 * as a chat-mode artifact tab.
 */
export default function BrowserView({ initialUrl, onUrlChange, onTitleChange }: Props): JSX.Element {
  const webviewRef = useRef<WebviewTag | null>(null)
  // webview 的 src 只在首次挂载时确定；后续导航完全由 webview 内部与 navigate() 管理。
  // 不能让 src 跟随 initialUrl prop 变化，否则每次父组件因 URL 上报而重渲染都会触发整页刷新。
  const initialSrcRef = useRef(normalizeAddress(initialUrl))
  const [address, setAddress] = useState(initialUrl)
  const [currentUrl, setCurrentUrl] = useState(initialUrl)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)

  const navigate = useCallback((target: string) => {
    const url = normalizeAddress(target)
    if (!url) return
    const wv = webviewRef.current
    if (wv) {
      wv.src = url
    }
    setAddress(url)
  }, [])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return

    const syncNav = (): void => {
      try {
        setCanGoBack(wv.canGoBack())
        setCanGoForward(wv.canGoForward())
      } catch {
        // webview 尚未就绪，忽略
      }
    }

    const handleNavigate = (e: Electron.DidNavigateEvent | Electron.DidNavigateInPageEvent): void => {
      setCurrentUrl(e.url)
      if (!editing) setAddress(e.url)
      onUrlChange?.(e.url)
      syncNav()
    }
    const handleStart = (): void => setLoading(true)
    const handleStop = (): void => {
      setLoading(false)
      syncNav()
    }
    const handleTitle = (e: Electron.PageTitleUpdatedEvent): void => onTitleChange?.(e.title)

    wv.addEventListener('did-navigate', handleNavigate)
    wv.addEventListener('did-navigate-in-page', handleNavigate)
    wv.addEventListener('did-start-loading', handleStart)
    wv.addEventListener('did-stop-loading', handleStop)
    wv.addEventListener('page-title-updated', handleTitle)
    return () => {
      wv.removeEventListener('did-navigate', handleNavigate)
      wv.removeEventListener('did-navigate-in-page', handleNavigate)
      wv.removeEventListener('did-start-loading', handleStart)
      wv.removeEventListener('did-stop-loading', handleStop)
      wv.removeEventListener('page-title-updated', handleTitle)
    }
  }, [editing, onUrlChange, onTitleChange])

  const goBack = (): void => {
    const wv = webviewRef.current
    if (wv?.canGoBack()) wv.goBack()
  }
  const goForward = (): void => {
    const wv = webviewRef.current
    if (wv?.canGoForward()) wv.goForward()
  }
  const reloadOrStop = (): void => {
    const wv = webviewRef.current
    if (!wv) return
    if (loading) wv.stop()
    else wv.reload()
  }

  return (
    <div className="browser-view">
      <div className="browser-toolbar">
        <button type="button" className="browser-nav-btn" title="后退" disabled={!canGoBack} onClick={goBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <button type="button" className="browser-nav-btn" title="前进" disabled={!canGoForward} onClick={goForward}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <button type="button" className="browser-nav-btn" title={loading ? '停止' : '刷新'} onClick={reloadOrStop}>
          {loading ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15" />
            </svg>
          )}
        </button>
        <input
          className="browser-address"
          value={address}
          spellCheck={false}
          onFocus={() => setEditing(true)}
          onBlur={() => {
            setEditing(false)
            setAddress(currentUrl)
          }}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
              navigate(address)
            } else if (e.key === 'Escape') {
              setAddress(currentUrl)
              e.currentTarget.blur()
            }
          }}
        />
        <button
          type="button"
          className="browser-nav-btn"
          title="在默认浏览器中打开"
          onClick={() => currentUrl && void window.lc.openExternal(currentUrl)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <path d="M15 3h6v6M10 14L21 3" />
          </svg>
        </button>
      </div>
      <webview
        ref={webviewRef as never}
        className="browser-webview"
        src={initialSrcRef.current}
        // @ts-expect-error allowpopups is a valid <webview> attribute not in React typings
        allowpopups="true"
      />
    </div>
  )
}
