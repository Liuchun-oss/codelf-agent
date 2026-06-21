import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Artifact } from './artifacts'
import { useRunStore } from '@/stores/runStore'
import { usePythonStore } from '@/stores/pythonStore'
import { ARTIFACT_FILE_SCHEME } from '@shared/appConfig'

/** Build an artifact-scheme URL the in-app iframe can load (file:// is blocked). */
function toArtifactUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  // codelf-artifact://local/D:/a/index.html — fixed host keeps it a standard URL.
  return `${ARTIFACT_FILE_SCHEME}://local${encodeURI(withLeadingSlash)}`
}

function openExternal(target: string): void {
  void window.lc.openExternal(target)
}

/**
 * Returns an incrementing counter that bumps (debounced) whenever the given
 * artifact file — or a sibling asset in the same directory — is written by the
 * agent or changes on disk. Used to auto-refresh previews.
 */
function useArtifactWriteSignal(path: string, enabled = true): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const dir = path.replace(/\\/g, '/').replace(/\/[^/]*$/, '').toLowerCase()
    const hit = (p: string): boolean => p.replace(/\\/g, '/').toLowerCase().startsWith(dir + '/')
    let timer: ReturnType<typeof setTimeout> | undefined
    const bump = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setTick((n) => n + 1), 250)
    }
    const offWrote = window.lc.onAgentWrote(({ path: p }) => {
      if (hit(p)) bump()
    })
    const offFs = window.lc.onFsEvent(({ paths }) => {
      if (paths.some(hit)) bump()
    })
    return () => {
      if (timer) clearTimeout(timer)
      offWrote()
      offFs()
    }
  }, [path, enabled])
  return tick
}

/** Web artifact: live iframe preview + open-in-browser + auto-reload on write. */
function WebView({ artifact }: { artifact: Artifact }): JSX.Element {
  const run = useRunStore((s) => s.runs[artifact.path])
  const [manualTick, setManualTick] = useState(0)
  // Static HTML served via the artifact scheme; a detected localhost URL takes
  // over if a dev server run is active for this path.
  const isLocalServer = !!run?.detectedUrl && /^https?:\/\//i.test(run.detectedUrl)
  const baseUrl = isLocalServer ? run!.detectedUrl! : toArtifactUrl(artifact.path)
  // file:// dev servers handle their own reloading; only static previews watch.
  const writeTick = useArtifactWriteSignal(artifact.path, !isLocalServer)
  // Cache-busting param forces the iframe to re-fetch when the file changes.
  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}_t=${writeTick}-${manualTick}`

  return (
    <div className="artifact-view web">
      <div className="artifact-view-bar">
        <span className="artifact-view-url" title={isLocalServer ? baseUrl : artifact.path}>
          {isLocalServer ? baseUrl : artifact.path}
        </span>
        <button
          type="button"
          className="artifact-view-btn"
          title="重新加载预览"
          onClick={() => setManualTick((n) => n + 1)}
        >
          刷新
        </button>
        <button
          type="button"
          className="artifact-view-btn"
          onClick={() => openExternal(isLocalServer ? baseUrl : artifact.path)}
        >
          默认浏览器打开
        </button>
      </div>
      <iframe
        key={url}
        className="artifact-view-iframe"
        src={url}
        title={`预览 ${artifact.name}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  )
}

/** Runnable artifact (script / dev server): run + stream stdout/stderr. */
function RunnableView({ artifact }: { artifact: Artifact }): JSX.Element {
  const run = useRunStore((s) => s.runs[artifact.path])
  const runArtifact = useRunStore((s) => s.runArtifact)
  const stopRun = useRunStore((s) => s.stopRun)
  const bodyRef = useRef<HTMLPreElement>(null)
  const running = run?.status === 'starting' || run?.status === 'running'

  // Python 环境选择器状态
  const isPython = /\.pyw?$/i.test(artifact.path)
  const { selected, envs, loading, init, discover, select, browse } = usePythonStore()
  const [showPicker, setShowPicker] = useState(false)
  const [filter, setFilter] = useState('')
  const [pickerPos, setPickerPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const pickerAnchorRef = useRef<HTMLButtonElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const closedAtRef = useRef(0)

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [run?.chunks])

  // 初始化 Python 环境
  useEffect(() => {
    if (isPython) {
      void init().then(() => void discover())
    }
  }, [isPython, init, discover])

  // Picker 点击外部关闭
  useEffect(() => {
    if (!showPicker) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closePicker()
    }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (pickerRef.current?.contains(t) || pickerAnchorRef.current?.contains(t)) return
      closePicker()
    }
    window.addEventListener('keydown', onKey)
    setTimeout(() => window.addEventListener('mousedown', onDown, true), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [showPicker])

  const openPicker = (): void => {
    if (showPicker || Date.now() - closedAtRef.current < 250) {
      setShowPicker(false)
      return
    }
    const rect = pickerAnchorRef.current?.getBoundingClientRect()
    if (rect) {
      const width = Math.max(420, Math.min(560, window.innerWidth - 40))
      let left = rect.left
      if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12
      // 向下展开：从按钮底部往下
      const top = rect.bottom + 6
      setPickerPos({ left: Math.max(12, left), top, width })
    }
    setFilter('')
    setShowPicker(true)
    void discover()
  }

  const closePicker = (): void => {
    closedAtRef.current = Date.now()
    setShowPicker(false)
  }

  const choosePython = async (env: typeof selected): Promise<void> => {
    if (env) await select(env)
    closePicker()
  }

  const onBrowsePython = async (): Promise<void> => {
    closePicker()
    await browse()
  }

  const filteredEnvs = envs.filter((e) => {
    if (!filter.trim()) return true
    const q = filter.toLowerCase()
    return e.label.toLowerCase().includes(q) || e.executable.toLowerCase().includes(q)
  })

  const statusLabel = !run
    ? '未运行'
    : run.status === 'starting'
      ? '启动中'
      : run.status === 'running'
        ? '运行中'
        : run.status === 'error'
          ? '失败'
          : '完成'

  return (
    <div className="artifact-view runnable">
      <div className="artifact-view-bar">
        <span className={`run-card-dot ${run?.status ?? ''}`} aria-hidden />
        <span className="artifact-view-status">{statusLabel}</span>
        <span className="artifact-view-spacer" aria-hidden />

        {/* Python 环境选择器 */}
        {isPython && (
          <>
            <button
              ref={pickerAnchorRef}
              type="button"
              className="artifact-view-btn"
              title={selected ? `Python 解释器：${selected.executable}` : '选择 Python 解释器'}
              onClick={openPicker}
              style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
                <path d="M11.9 2c-2 0-3.5.4-3.5 2.3v1.6h3.6v.6H5.6C3.6 6.5 3 8 3 10s.6 3.6 2.6 3.6h1.2v-1.9c0-1.8 1.5-3.3 3.4-3.3h3.5c1.6 0 2.9-1.3 2.9-2.9V4.3C16.9 2.6 15.6 2 13.7 2zm-2 1.3a.7.7 0 110 1.4.7.7 0 010-1.4z" />
                <path d="M12.1 22c2 0 3.5-.4 3.5-2.3v-1.6H12v-.6h6.4c2 0 2.6-1.5 2.6-3.5s-.6-3.6-2.6-3.6h-1.2v1.9c0 1.8-1.5 3.3-3.4 3.3h-3.5c-1.6 0-2.9 1.3-2.9 2.9v2.9c0 1.7 1.3 2.3 3.2 2.3zm2-1.3a.7.7 0 110-1.4.7.7 0 010 1.4z" opacity="0.85" />
              </svg>
              <span style={{ maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selected ? selected.label : '选择解释器'}
              </span>
            </button>

            {showPicker && pickerPos && createPortal(
              <div
                ref={pickerRef}
                className="python-picker"
                style={{ left: pickerPos.left, top: pickerPos.top, width: pickerPos.width }}
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
                    onClick={() => void onBrowsePython()}
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
                  ) : filteredEnvs.length === 0 ? (
                    <div className="python-picker-empty">未找到 Python 解释器</div>
                  ) : (
                    filteredEnvs.map((env) => {
                      const isSel = selected?.id === env.id
                      const kindTag = env.kind === 'conda' ? 'Conda' : env.kind === 'venv' ? 'venv' : env.kind === 'pyenv' ? 'pyenv' : env.kind === 'global' ? '全局' : ''
                      return (
                        <div
                          key={env.id}
                          className={`python-picker-row${isSel ? ' selected' : ''}`}
                          onClick={() => void choosePython(env)}
                        >
                          <span className="python-picker-label">{env.label}</span>
                          <span className="python-picker-path">{env.executable}</span>
                          {env.recommended ? (
                            <span className="python-picker-tag rec">推荐</span>
                          ) : kindTag ? (
                            <span className="python-picker-tag">{kindTag}</span>
                          ) : null}
                        </div>
                      )
                    })
                  )}
                </div>
                {loading && envs.length > 0 ? (
                  <div className="python-picker-footer">正在刷新…</div>
                ) : null}
              </div>,
              document.body
            )}
          </>
        )}

        {run?.detectedUrl && !run.detectedUrl.startsWith('file://') && (
          <button
            type="button"
            className="artifact-view-btn"
            onClick={() => openExternal(run.detectedUrl!)}
          >
            浏览器打开 {run.detectedUrl}
          </button>
        )}
        {running ? (
          <button type="button" className="artifact-view-btn danger" onClick={() => void stopRun(artifact.path)}>
            停止
          </button>
        ) : (
          <button type="button" className="artifact-view-btn" onClick={() => void runArtifact(artifact.path)}>
            {run ? '重新运行' : '运行'}
          </button>
        )}
      </div>
      {run?.command ? (
        <div className="artifact-view-cmd" title={run.command}>
          $ {run.command}
        </div>
      ) : null}
      {run && run.chunks.length > 0 ? (
        <pre ref={bodyRef} className="artifact-view-output">
          {run.chunks.map((c, i) => (
            <span key={i} className={c.stream === 'stderr' ? 'run-card-stderr' : undefined}>
              {c.data}
            </span>
          ))}
        </pre>
      ) : running ? (
        <div className="artifact-view-empty">等待输出…</div>
      ) : (
        <div className="artifact-view-empty">点击「运行」执行该脚本，输出会显示在这里。</div>
      )}
    </div>
  )
}

/** Image artifact: render directly via readFileSafe data URL. */
function ImageView({ artifact }: { artifact: Artifact }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const writeTick = useArtifactWriteSignal(artifact.path)

  useEffect(() => {
    let cancelled = false
    void window.lc.readFileSafe(artifact.path).then((res) => {
      if (cancelled) return
      if (res.ok && res.dataUrl) setSrc(res.dataUrl)
      else setError(res.error ?? '无法读取图片')
    })
    return () => {
      cancelled = true
    }
  }, [artifact.path, writeTick])

  return (
    <div className="artifact-view image">
      <div className="artifact-view-bar">
        <span className="artifact-view-spacer" aria-hidden />
        <button type="button" className="artifact-view-btn" onClick={() => openExternal(artifact.path)}>
          默认应用打开
        </button>
      </div>
      <div className="artifact-view-imagebox">
        {src ? (
          <img src={src} alt={artifact.name} />
        ) : (
          <div className="artifact-view-empty">{error ?? '加载中…'}</div>
        )}
      </div>
    </div>
  )
}

/** Text-like artifact (markdown/json/csv/...): render raw content. */
function TextView({ artifact }: { artifact: Artifact }): JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const writeTick = useArtifactWriteSignal(artifact.path)

  useEffect(() => {
    let cancelled = false
    void window.lc.readFileSafe(artifact.path).then((res) => {
      if (cancelled) return
      if (res.ok && res.kind === 'text') setContent(res.content ?? '')
      else if (res.ok) setError('该文件不是文本，无法直接预览')
      else setError(res.error ?? '无法读取文件')
    })
    return () => {
      cancelled = true
    }
  }, [artifact.path, writeTick])

  return (
    <div className="artifact-view text">
      <div className="artifact-view-bar">
        <span className="artifact-view-spacer" aria-hidden />
        <button type="button" className="artifact-view-btn" onClick={() => openExternal(artifact.path)}>
          默认应用打开
        </button>
      </div>
      {content != null ? (
        <pre className="artifact-view-textbody">{content}</pre>
      ) : (
        <div className="artifact-view-empty">{error ?? '加载中…'}</div>
      )}
    </div>
  )
}

/** PDF / other binary: offer open-in-default-app. */
function FallbackView({ artifact }: { artifact: Artifact }): JSX.Element {
  const isPdf = artifact.kind === 'pdf'
  const fileUrl = toArtifactUrl(artifact.path)
  return (
    <div className="artifact-view other">
      {isPdf ? (
        <iframe className="artifact-view-iframe" src={fileUrl} title={`预览 ${artifact.name}`} />
      ) : (
        <div className="artifact-view-fallback">
          <p className="artifact-view-fallback-path">{artifact.path}</p>
          <p className="artifact-view-fallback-hint">该类型暂不支持内嵌预览。</p>
          <button type="button" className="artifact-view-btn" onClick={() => openExternal(artifact.path)}>
            用默认应用打开
          </button>
        </div>
      )}
    </div>
  )
}

export default function ArtifactView({ artifact }: { artifact: Artifact }): JSX.Element {
  switch (artifact.kind) {
    case 'web':
      return <WebView artifact={artifact} />
    case 'runnable':
      return <RunnableView artifact={artifact} />
    case 'image':
      return <ImageView artifact={artifact} />
    case 'text':
      return <TextView artifact={artifact} />
    case 'pdf':
    case 'other':
    default:
      return <FallbackView artifact={artifact} />
  }
}
