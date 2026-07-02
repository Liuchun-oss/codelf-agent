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
import { useEditorStore } from '@/stores/editorStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useUiStore } from '@/stores/uiStore'
import { toast } from '@/stores/toastStore'
import { basename, getSep } from '@/utils/path'
import { ARTIFACT_FILE_SCHEME } from '@shared/appConfig'
import { useTypewriterText } from './useTypewriterText'
import BrowserPreviewImage, { parseBrowserPreviewId } from './BrowserPreviewImage'
import AudioPlayer from './AudioPlayer'



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

// 把本地文件路径 / file:// URL 转成内置的 codelf-artifact:// 协议，使 <img>/<video>/<audio>
// 能加载本地文件（Electron 渲染进程默认禁止 file://）。已是 http(s)/data:/blob: 或自定义协议
// 的地址原样返回。用于工人产出的截图/生成图片以本地绝对路径内联显示。
const WEB_SCHEME_RE = /^(https?:|data:|blob:|[a-z][a-z0-9+.-]*-artifact:|[a-z][a-z0-9+.-]*-preview:)/i

function resolveMediaSrc(src: string): string {
  const s = src.trim()
  if (!s) return s
  if (WEB_SCHEME_RE.test(s)) return s
  let p = s
  if (/^file:\/\//i.test(s)) {
    try {
      p = decodeURIComponent(new URL(s).pathname)
      // Windows: "/D:/a/b.png" → "D:/a/b.png"
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
    } catch {
      return s
    }
  }
  // 仅对看起来像本地绝对路径的地址走 artifact 协议（Windows 盘符 / POSIX 绝对路径）。
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\')
  if (!isAbsolute) return s
  const normalized = p.replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `${ARTIFACT_FILE_SCHEME}://local${encodeURI(withLeadingSlash)}`
}

// 普通 markdown 图片：加载失败时自动隐藏，避免显示损坏图标。
// （模型有时会在正文里重复嵌入一张它记不全 URL 的图，导致坏图标。）
function MarkdownImage({ src, alt, ...rest }: { src?: string; alt?: string }): JSX.Element | null {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return null
  return <img className="cm-md-img" src={resolveMediaSrc(src)} alt={alt ?? ''} loading="lazy" onError={() => setFailed(true)} {...rest} />
}

// 生成的视频以 markdown 图片语法承载（![video](url)）。通过 alt=video 或视频扩展名识别，
// 渲染为可播放的 <video> 播放器，而非图片。
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)(\?|#|$)/i

function isVideoSource(src: string, alt: string): boolean {
  if (alt.trim().toLowerCase() === 'video') return true
  return VIDEO_EXT_RE.test(src)
}

function MarkdownVideo({ src }: { src: string }): JSX.Element | null {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <video
      className="cm-md-video"
      src={resolveMediaSrc(src)}
      controls
      playsInline
      preload="metadata"
      onError={() => setFailed(true)}
    />
  )
}

// 生成的语音以 markdown 图片语法承载（![audio](url)）。通过 alt=audio 或音频扩展名识别，
// 渲染为可播放的 <audio> 播放条，而非图片。
const AUDIO_EXT_RE = /\.(mp3|wav|ogg|oga|opus|flac|m4a|aac)(\?|#|$)/i

function isAudioSource(src: string, alt: string): boolean {
  if (alt.trim().toLowerCase() === 'audio') return true
  return AUDIO_EXT_RE.test(src)
}

function MarkdownAudio({ src }: { src: string }): JSX.Element | null {
  return <AudioPlayer src={resolveMediaSrc(src)} className="cm-md-audio" />
}

// 识别 inline code 是否像一个文件路径（保守判断，避免把普通代码片段当文件）。
const FILE_EXT_RE =
  /\.(tsx?|jsx?|mjs|cjs|vue|svelte|css|scss|less|html?|json|jsonc|ya?ml|toml|ini|md|mdx|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|swift|sh|bash|ps1|sql|xml|txt|env|lock|cfg|conf|gitignore|dockerfile)$/i

// 末尾可选的 :行 或 :行:列
const LINE_SUFFIX_RE = /:(\d+)(?::(\d+))?$/

function parseFileRef(raw: string): { path: string; line?: number; col?: number } | null {
  const text = raw.trim()
  if (!text || /\s/.test(text)) return null
  
  if (/^[a-z]+:\/\//i.test(text)) return null

  let path = text
  let line: number | undefined
  let col: number | undefined
  const m = LINE_SUFFIX_RE.exec(text)
  if (m) {
    path = text.slice(0, m.index)
    line = Number(m[1])
    col = m[2] ? Number(m[2]) : undefined
  }
  if (!path) return null

  const hasSep = path.includes('/') || path.includes('\\')
  const looksLikeFile = FILE_EXT_RE.test(path) || /(^|[\\/])dockerfile$/i.test(path)
  // 要么含路径分隔符，要么带可识别的代码文件扩展名，才认为是文件引用
  if (!hasSep && !looksLikeFile) return null
  
  if (path.length > 260) return null
  return { path, line, col }
}

function resolveAbsPath(workspaceRoot: string | undefined, p: string): string {
  const isAbsolute = /^[a-z]:[\\/]/i.test(p) || p.startsWith('/') || p.startsWith('\\')
  if (isAbsolute || !workspaceRoot) return p
  const sep = getSep(workspaceRoot)
  const rel = p.replace(/^\.?[\\/]/, '').replace(/[\\/]/g, sep)
  return workspaceRoot.replace(/[\\/]$/, '') + sep + rel
}

function FileLink({
  fileRef,
  children
}: {
  fileRef: { path: string; line?: number; col?: number }
  children: ReactNode
}): JSX.Element {
  const open = async (): Promise<void> => {
    const workspaceRoot = useWorkspaceStore.getState().workspace?.path
    const abs = resolveAbsPath(workspaceRoot, fileRef.path)
    const exists = await window.lc.exists(abs)
    if (!exists) {
      toast.warn(`找不到文件：${fileRef.path}`)
      return
    }
    const name = basename(abs)
    if (fileRef.line != null) {
      await useEditorStore.getState().openFileAt(abs, name, fileRef.line, fileRef.col ?? 1)
    } else {
      await useEditorStore.getState().openFile(abs, name)
    }
  }
  return (
    <code
      className="cm-md-code-inline cm-md-file-link"
      role="link"
      tabIndex={0}
      title={`打开 ${fileRef.path}`}
      onClick={() => void open()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          void open()
        }
      }}
    >
      {children}
    </code>
  )
}

function InlineCode({ children, ...rest }: { children?: ReactNode }): JSX.Element {
  const text = extractText(children)
  const inAppUrl = normalizeInAppUrl(text)
  if (inAppUrl) {
    return (
      <code
        className="cm-md-code-inline cm-md-file-link"
        role="link"
        tabIndex={0}
        title={`在内置浏览器打开 ${text.trim()}`}
        onClick={() => openInAppBrowser(inAppUrl)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openInAppBrowser(inAppUrl)
          }
        }}
      >
        {children}
      </code>
    )
  }
  const fileRef = parseFileRef(text)
  if (fileRef) return <FileLink fileRef={fileRef}>{children}</FileLink>
  return (
    <code className="cm-md-code-inline" {...rest}>
      {children}
    </code>
  )
}

// 判断链接是否应由内置浏览器打开：http/https 以及 localhost / 127.0.0.1 / 裸 host:port。
function normalizeInAppUrl(href: string | undefined): string | null {
  if (!href) return null
  const h = href.trim()
  if (/^https?:\/\//i.test(h)) return h
  // localhost:3000 / 127.0.0.1:8080 / localhost/path 等无协议写法，补 http://
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(h)) return `http://${h}`
  return null
}

// 按当前视图把 URL 分发到对应的内置浏览器面板（IDE → 编辑器浏览器；首页 → 产物区浏览器）。
function openInAppBrowser(url: string): void {
  if (useUiStore.getState().appView === 'workspace') {
    useEditorStore.getState().openBrowser(url)
  } else {
    useUiStore.getState().openHomeBrowser(url)
  }
}

function MarkdownLink({
  href,
  children,
  ...rest
}: {
  href?: string
  children?: ReactNode
}): JSX.Element {
  const inAppUrl = normalizeInAppUrl(href)
  if (inAppUrl) {
    return (
      <a
        className="cm-md-link"
        href={href}
        onClick={(e) => {
          e.preventDefault()
          openInAppBrowser(inAppUrl)
        }}
        {...rest}
      >
        {children}
      </a>
    )
  }
  return (
    <a className="cm-md-link" href={href} target="_blank" rel="noreferrer noopener" {...rest}>
      {children}
    </a>
  )
}

const COMPONENTS: Components = {
  a: ({ node: _node, children, href, ...rest }) => (
    <MarkdownLink href={href} {...rest}>
      {children}
    </MarkdownLink>
  ),
  img: ({ node: _node, src, alt, ...rest }) => {
    if (typeof src === 'string') {
      if (isVideoSource(src, alt ?? '')) {
        return <MarkdownVideo src={src} />
      }
      if (isAudioSource(src, alt ?? '')) {
        return <MarkdownAudio src={src} />
      }
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
      return <InlineCode {...rest}>{children}</InlineCode>
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
