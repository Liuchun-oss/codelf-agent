import { Children, cloneElement, createContext, isValidElement, memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import mermaid from 'mermaid'
import rehypeKatex from 'rehype-katex'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { highlightCodeHtml } from '@/highlight'
import { onThemeChange } from '@/stores/themeStore'
import { useTypewriterText } from './useTypewriterText'
import BrowserPreviewImage, { parseBrowserPreviewId } from './BrowserPreviewImage'



const CALLOUT_META: Record<string, { label: string; tone: string }> = {
  note: { label: 'Note', tone: 'note' },
  tip: { label: 'Tip', tone: 'tip' },
  important: { label: 'Important', tone: 'important' },
  warning: { label: 'Warning', tone: 'warning' },
  caution: { label: 'Caution', tone: 'caution' },
  info: { label: 'Info', tone: 'note' },
  success: { label: 'Success', tone: 'tip' },
  danger: { label: 'Danger', tone: 'caution' }
}

const REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkMath]
const REHYPE_PLUGINS = [rehypeKatex]

const StreamingContext = createContext(false)

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  
  theme: 'base',
  themeVariables: {
    darkMode: true,
    background: 'transparent',
    fontFamily: 'var(--font-sans, Inter, sans-serif)',
    
    primaryColor: '#39332f',
    primaryTextColor: '#f6f1e9',
    primaryBorderColor: '#6fb3a3',
    secondaryColor: '#423b35',
    secondaryTextColor: '#f6f1e9',
    secondaryBorderColor: '#6fb3a3',
    tertiaryColor: '#2e2a26',
    tertiaryTextColor: '#f6f1e9',
    tertiaryBorderColor: '#5a534c',
    
    lineColor: '#8a8178',
    textColor: '#ece5db',
    
    mainBkg: '#39332f',
    nodeBorder: '#6fb3a3',
    nodeTextColor: '#f6f1e9',
    
    edgeLabelBackground: '#2a2624',
    labelBackground: '#2a2624',
    labelBoxBkgColor: '#39332f',
    labelBoxBorderColor: '#6fb3a3',
    labelTextColor: '#f6f1e9',
    
    clusterBkg: '#221f1d',
    clusterBorder: '#3a352f',
    titleColor: '#f6f1e9',
    
    noteBkgColor: '#423b35',
    noteTextColor: '#f6f1e9',
    noteBorderColor: '#6fb3a3'
  }
})

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children)
  return ''
}

function stripFirstText(node: ReactNode, pattern: RegExp): ReactNode {
  if (typeof node === 'string') return node.replace(pattern, '')
  if (typeof node === 'number') return node
  if (Array.isArray(node)) {
    let stripped = false
    return node.map((child) => {
      if (stripped) return child
      const next = stripFirstText(child, pattern)
      stripped = next !== child
      return next
    })
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return node
  const children = node.props.children
  const nextChildren = stripFirstText(children, pattern)
  return nextChildren === children ? node : cloneElement(node as ReactElement<{ children?: ReactNode }>, undefined, nextChildren)
}

function copyText(text: string): Promise<void> | undefined {
  return navigator.clipboard?.writeText(text)
}

function MermaidBlock({ code }: { code: string }): JSX.Element {
  const reactId = useId()
  const streaming = useContext(StreamingContext)
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (streaming) return
    let alive = true
    const id = `cm-md-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`

    setSvg(null)
    setError(null)

    void mermaid
      .render(id, code)
      .then(({ svg: renderedSvg }) => {
        if (alive) setSvg(renderedSvg)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(err instanceof Error ? err.message : 'Mermaid 图表渲染失败')
      })

    return () => {
      alive = false
    }
  }, [code, reactId, streaming])

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [])

  const markCopied = (label: string): void => {
    setCopied(label)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(null), 1200)
  }

  const handleCopySource = (): void => {
    void copyText(code)?.then(() => markCopied('源码'))
  }

  const handleCopySvg = (): void => {
    if (!svg) return
    void copyText(svg)?.then(() => markCopied('SVG'))
  }

  if (error) return <CodeBlock code={code} lang="mermaid" error={error} />

  return (
    <div className="cm-md-chart">
      <div className="cm-md-chart-head">
        <span>Mermaid 图表</span>
        <div className="cm-md-chart-actions">
          <button type="button" onClick={handleCopySource}>
            {copied === '源码' ? '已复制源码' : '复制源码'}
          </button>
          <button type="button" onClick={handleCopySvg} disabled={!svg}>
            {copied === 'SVG' ? '已复制 SVG' : '复制 SVG'}
          </button>
        </div>
      </div>
      <div className="cm-md-mermaid" aria-label="Mermaid diagram">
        {svg ? (
          <div className="cm-md-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <div className="cm-md-mermaid-loading">{streaming ? '等待图表输出完成…' : '正在渲染图表…'}</div>
        )}
      </div>
    </div>
  )
}

function CodeBlock({ code, lang, error }: { code: string; lang?: string; error?: string }): JSX.Element {
  const streaming = useContext(StreamingContext)
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [themeTick, setThemeTick] = useState(0)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => onThemeChange(() => setThemeTick((t) => t + 1)), [])

  useEffect(() => {
    if (streaming) {
      setHtml(null)
      return
    }
    let alive = true
    void highlightCodeHtml(code, lang).then((out) => {
      if (alive) setHtml(out)
    })
    return () => {
      alive = false
    }
  }, [code, lang, streaming, themeTick])

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [])

  const copy = (): void => {
    void copyText(code)?.then(() => {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1200)
    })
  }

  const label = lang?.trim() || 'text'

  return (
    <div className="cm-md-pre">
      <div className="cm-md-pre-head">
        <span className="cm-md-pre-lang">{label}</span>
        <button type="button" className="cm-md-pre-copy" onClick={copy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {error ? <div className="cm-md-pre-error">{error}</div> : null}
      {html ? (
        <div className="cm-md-pre-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="cm-md-pre-body">
          <pre>
            <code>{code}</code>
          </pre>
        </div>
      )}
    </div>
  )
}

function TableBlock({ children }: { children: ReactNode }): JSX.Element {
  const tableRef = useRef<HTMLTableElement | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [])

  const copyTable = (): void => {
    const rows = Array.from(tableRef.current?.rows ?? [])
    const text = rows
      .map((row) =>
        Array.from(row.cells)
          .map((cell) => cell.innerText.trim())
          .join('\t')
      )
      .join('\n')

    void copyText(text)?.then(() => {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="cm-md-table-card">
      <div className="cm-md-table-toolbar">
        <span>Markdown 表格</span>
        <button type="button" onClick={copyTable}>
          {copied ? '已复制' : '复制表格'}
        </button>
      </div>
      <div className="cm-md-table-scroll">
        <table ref={tableRef}>{children}</table>
      </div>
    </div>
  )
}

// 普通 markdown 图片：加载失败时自动隐藏，避免显示损坏图标。
// （模型有时会在正文里重复嵌入一张它记不全 URL 的图，导致坏图标。）
function MarkdownImage({ src, alt, ...rest }: { src?: string; alt?: string }): JSX.Element | null {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return null
  return <img className="cm-md-img" src={src} alt={alt ?? ''} loading="lazy" onError={() => setFailed(true)} {...rest} />
}

const COMPONENTS: Components = {
  a: ({ node: _node, children, href, ...rest }) => (
    <a className="cm-md-link" href={href} target="_blank" rel="noreferrer noopener" {...rest}>
      {children}
    </a>
  ),
  img: ({ node: _node, src, alt, ...rest }) => {
    if (typeof src === 'string') {
      const previewId = parseBrowserPreviewId(src)
      if (previewId) {
        return <BrowserPreviewImage previewId={previewId} className="cm-md-img" alt={alt ?? ''} />
      }
    }
    return <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} {...rest} />
  },
  blockquote: ({ node: _node, children }) => {
    const text = extractText(children).trimStart()
    const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO|SUCCESS|DANGER)\]\s*/i.exec(text)
    if (!match) return <blockquote>{children}</blockquote>

    const kind = match[1].toLowerCase()
    const meta = CALLOUT_META[kind] ?? CALLOUT_META.note
    const content = stripFirstText(Children.toArray(children), /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO|SUCCESS|DANGER)\]\s*/i)

    return (
      <div className={`cm-md-callout cm-md-callout-${meta.tone}`}>
        <div className="cm-md-callout-title">{meta.label}</div>
        <div className="cm-md-callout-body">{content}</div>
      </div>
    )
  },
  table: ({ node: _node, children }) => <TableBlock>{children}</TableBlock>,
  input: ({ node: _node, type, ...rest }) =>
    type === 'checkbox' ? (
      <input type="checkbox" className="cm-md-task" disabled checked={rest.checked} readOnly />
    ) : (
      <input type={type} {...rest} />
    ),
  li: ({ node: _node, className, children }) => {
    const isTask = typeof className === 'string' && className.includes('task-list-item')
    return <li className={isTask ? 'cm-md-task-item' : undefined}>{children}</li>
  },
  pre: ({ children }) => <>{children}</>,
  code: ({ node: _node, className, children, ...rest }) => {
    const match = /language-([\w+#-]+)/.exec(className || '')
    const text = String(children ?? '')
    const lang = match?.[1]?.toLowerCase()
    const isBlock = !!match || text.includes('\n')
    if (!isBlock) {
      return (
        <code className="cm-md-code-inline" {...rest}>
          {children}
        </code>
      )
    }
    const code = text.replace(/\n$/, '')
    if (lang === 'mermaid' || lang === 'mmd') return <MermaidBlock code={code} />
    return <CodeBlock code={code} lang={match?.[1]} />
  }
}

function useThrottledValue<T>(value: T, intervalMs: number, enabled: boolean): T {
  const [throttled, setThrottled] = useState(value)
  const lastRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setThrottled(value)
      return
    }
    const now = Date.now()
    const elapsed = now - lastRef.current
    if (elapsed >= intervalMs) {
      lastRef.current = now
      setThrottled(value)
      return
    }
    timerRef.current = setTimeout(() => {
      lastRef.current = Date.now()
      setThrottled(value)
    }, intervalMs - elapsed)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [value, intervalMs, enabled])

  return throttled
}

function MarkdownView({
  text,
  streaming,
  onTypingDone
}: {
  text: string
  streaming?: boolean
  onTypingDone?: (done: boolean) => void
}): JSX.Element {
  const visibleText = useTypewriterText(text, streaming)

  const caughtUp = visibleText.length >= text.length
  const done = !streaming && caughtUp
  useLayoutEffect(() => {
    onTypingDone?.(done)
  }, [done, onTypingDone])

  // 流式期间每次重解析的是“到目前为止的整段文本”，成本随长度增长，累计约 O(n²)。
  // 文本越长，把节流间隔拉得越大，降低重解析频率，避免长回答时持续打满 CPU。
  // 非流式（caughtUp）时 enabled=false，直接走完整渲染，保证最终结果即时且完整。
  const throttleMs = useMemo(() => {
    const len = visibleText.length
    if (len < 4_000) return 80
    if (len < 12_000) return 160
    if (len < 32_000) return 320
    return 600
  }, [visibleText.length])

  const source = useThrottledValue(visibleText, throttleMs, !!streaming && !caughtUp)

  const rendered = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    ),
    [source]
  )

  return (
    <StreamingContext.Provider value={!!streaming && !caughtUp}>
      <div className={`cm-md${streaming ? ' streaming' : ''}`}>{rendered}</div>
    </StreamingContext.Provider>
  )
}

export default memo(MarkdownView)
