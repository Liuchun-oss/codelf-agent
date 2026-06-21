import { useEffect, useRef } from 'react'
import { useSearchStore } from '@/stores/searchStore'
import { useUiStore } from '@/stores/uiStore'
import { useEditorStore } from '@/stores/editorStore'
import { useDialogStore } from '@/stores/dialogStore'
import ResizeHandle from '@/components/common/ResizeHandle'
import FileIcon from '@/components/common/FileIcon'
import { basename, dirname } from '@/utils/path'
import type { SearchMatch } from '@/types'

function Highlight({ match }: { match: SearchMatch }): JSX.Element {
  const trimmed = match.preview.trimStart()
  const lead = match.preview.length - trimmed.length
  const start = Math.max(0, match.col - 1 - lead)
  const before = trimmed.slice(0, start)
  const mid = trimmed.slice(start, start + match.matchLength)
  const after = trimmed.slice(start + match.matchLength)
  return (
    <span className="search-line">
      {before}
      <span className="search-hit">{mid}</span>
      {after}
    </span>
  )
}

export default function SearchPanel(): JSX.Element {
  const {
    query,
    replacement,
    options,
    results,
    loading,
    truncated,
    error,
    collapsed,
    setQuery,
    setReplacement,
    toggleOption,
    toggleCollapsed,
    run,
    replaceAll
  } = useSearchStore()

  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  
  useEffect(() => {
    const t = setTimeout(() => void run(), 250)
    return () => clearTimeout(t)
  }, [query, options, run])

  const total = results.reduce((n, r) => n + r.matches.length, 0)

  const onReplaceAll = async (): Promise<void> => {
    const ok = await useDialogStore.getState().confirm({
      title: '全部替换',
      message: `将在 ${results.length} 个文件中替换全部 ${total} 处匹配，此操作会写入磁盘且不可撤销。是否继续？`,
      confirmText: '全部替换',
      danger: true
    })
    if (!ok) return
    const changed = await replaceAll()
    await useDialogStore.getState().confirm({
      title: '替换完成',
      message: `已修改 ${changed} 个文件。`,
      confirmText: '知道了',
      cancelText: '关闭'
    })
  }

  return (
    <div className="sidebar">
      <div className="panel-header">
        <span>搜索</span>
      </div>

      <div className="search-controls">
        <div className="search-field">
          <input
            ref={inputRef}
            className="search-input"
            placeholder="搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="search-opts">
            <button
              className={`search-opt${options.caseSensitive ? ' on' : ''}`}
              title="区分大小写"
              onClick={() => toggleOption('caseSensitive')}
            >
              Aa
            </button>
            <button
              className={`search-opt${options.wholeWord ? ' on' : ''}`}
              title="全字匹配"
              onClick={() => toggleOption('wholeWord')}
            >
              ab
            </button>
            <button
              className={`search-opt${options.regex ? ' on' : ''}`}
              title="使用正则表达式"
              onClick={() => toggleOption('regex')}
            >
              .*
            </button>
          </div>
        </div>
        <div className="search-field">
          <input
            className="search-input"
            placeholder="替换"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
          <button
            className="search-opt"
            title="全部替换"
            disabled={results.length === 0}
            onClick={() => void onReplaceAll()}
          >
            ⇄
          </button>
        </div>
      </div>

      <div className="search-summary">
        {error ? (
          <span className="search-error">{error}</span>
        ) : loading ? (
          '搜索中…'
        ) : query ? (
          `${total} 个结果，${results.length} 个文件${truncated ? '（已截断）' : ''}`
        ) : (
          ''
        )}
      </div>

      <div className="search-results">
        {results.map((file) => {
          const name = basename(file.path)
          const isCollapsed = collapsed.has(file.path)
          return (
            <div key={file.path} className="search-group">
              <div className="search-group-header" onClick={() => toggleCollapsed(file.path)}>
                <span className="twisty">{isCollapsed ? '▸' : '▾'}</span>
                <FileIcon name={name} />
                <span className="search-file-name">{name}</span>
                <span className="search-file-dir" title={file.path}>
                  {dirname(file.path)}
                </span>
                <span className="search-count">{file.matches.length}</span>
              </div>
              {!isCollapsed &&
                file.matches.map((m, i) => (
                  <div
                    key={i}
                    className="search-match"
                    title={`行 ${m.line}`}
                    onClick={() =>
                      void useEditorStore.getState().openFileAt(file.path, name, m.line, m.col)
                    }
                  >
                    <Highlight match={m} />
                  </div>
                ))}
            </div>
          )
        })}
      </div>

      <ResizeHandle
        edge="right"
        title="拖动调整宽度"
        getSize={() => useUiStore.getState().sidebarWidth}
        onResize={(w) => useUiStore.getState().setSidebarWidth(w)}
      />
    </div>
  )
}
