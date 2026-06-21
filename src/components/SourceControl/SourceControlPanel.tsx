import { useEffect } from 'react'
import { useGitStore, statusLabel } from '@/stores/gitStore'
import { useUiStore } from '@/stores/uiStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import ResizeHandle from '@/components/common/ResizeHandle'
import FileIcon from '@/components/common/FileIcon'
import { basename, dirname } from '@/utils/path'
import type { GitFileChange } from '@shared/gitTypes'

function ChangeRow({
  change,
  staged
}: {
  change: GitFileChange
  staged: boolean
}): JSX.Element {
  const { openDiff, stage, unstage, discard } = useGitStore()
  const name = basename(change.displayPath)
  const dir = dirname(change.displayPath)

  return (
    <div
      className={`scm-row scm-status-${change.status}`}
      title={change.displayPath}
      onClick={() => void openDiff(change)}
    >
      <FileIcon name={name} size={16} />
      <span className="scm-name">{name}</span>
      <span className="scm-dir">{dir === '.' ? '' : dir}</span>
      <span className="scm-actions" onClick={(e) => e.stopPropagation()}>
        {change.status !== 'untracked' && change.status !== 'conflicted' && (
          <button
            className="scm-action"
            title="放弃更改"
            onClick={() => void discard(change)}
          >
            ↩
          </button>
        )}
        {staged ? (
          <button className="scm-action" title="取消暂存" onClick={() => void unstage(change)}>
            −
          </button>
        ) : (
          <button className="scm-action" title="暂存更改" onClick={() => void stage(change)}>
            +
          </button>
        )}
      </span>
      <span className={`scm-badge scm-badge-${change.status}`}>{statusLabel(change.status)}</span>
    </div>
  )
}

export default function SourceControlPanel(): JSX.Element {
  const {
    status,
    loading,
    busy,
    message,
    generating,
    amend,
    setMessage,
    setAmend,
    refresh,
    stageAll,
    unstageAll,
    commit,
    generateMessage,
    push,
    pull,
    switchBranch
  } = useGitStore()

  const workspace = useWorkspaceStore((s) => s.workspace)
  const sidebarView = useUiStore((s) => s.sidebarView)

  
  useEffect(() => {
    if (sidebarView === 'scm') void refresh()
  }, [sidebarView, workspace?.path, refresh])

  const staged = status?.staged ?? []
  const unstaged = status?.unstaged ?? []
  const commitAll = staged.length === 0 && unstaged.length > 0
  const canCommit = (staged.length > 0 || unstaged.length > 0 || amend) && !busy

  if (!workspace) {
    return (
      <div className="sidebar">
        <div className="panel-header">
          <span>源代码管理</span>
        </div>
        <div className="scm-empty">尚未打开文件夹。</div>
        <ResizeHandle
          edge="right"
          title="拖动调整宽度"
          getSize={() => useUiStore.getState().sidebarWidth}
          onResize={(w) => useUiStore.getState().setSidebarWidth(w)}
        />
      </div>
    )
  }

  if (status && !status.isRepo) {
    return (
      <div className="sidebar">
        <div className="panel-header">
          <span>源代码管理</span>
          <button className="panel-header-btn" title="刷新" onClick={() => void refresh()}>
            ⟳
          </button>
        </div>
        <div className="scm-empty">当前文件夹不是 Git 仓库。</div>
        <ResizeHandle
          edge="right"
          title="拖动调整宽度"
          getSize={() => useUiStore.getState().sidebarWidth}
          onResize={(w) => useUiStore.getState().setSidebarWidth(w)}
        />
      </div>
    )
  }

  return (
    <div className="sidebar">
      <div className="panel-header">
        <span>源代码管理</span>
        <div className="scm-header-actions">
          <button
            className="panel-header-btn"
            title="生成提交信息（AI）"
            disabled={generating || staged.length === 0}
            onClick={() => void generateMessage()}
          >
            {generating ? '…' : '✦'}
          </button>
          <button className="panel-header-btn" title="刷新" onClick={() => void refresh()}>
            ⟳
          </button>
        </div>
      </div>

      <div className="scm-branch-bar">
        <button className="scm-branch" title="切换 / 新建分支" onClick={() => void switchBranch()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="6" cy="6" r="2.5" />
            <circle cx="6" cy="18" r="2.5" />
            <circle cx="18" cy="8" r="2.5" />
            <path d="M6 8.5v7M18 10.5c0 4-4 3.5-9 3.5" strokeLinecap="round" />
          </svg>
          <span className="scm-branch-name">
            {status?.detached ? '(分离 HEAD)' : status?.branch ?? '—'}
          </span>
        </button>
        <div className="scm-sync">
          {status?.hasUpstream && (status.behind ? <span title="落后提交数">↓{status.behind}</span> : null)}
          {status?.hasUpstream && (status.ahead ? <span title="领先提交数">↑{status.ahead}</span> : null)}
          <button className="scm-action" title="拉取" disabled={busy} onClick={() => void pull()}>
            ↓
          </button>
          <button className="scm-action" title="推送" disabled={busy} onClick={() => void push()}>
            ↑
          </button>
        </div>
      </div>

      <div className="scm-commit-box">
        <textarea
          className="scm-message"
          placeholder={amend ? '修改最近一次提交的信息…' : '提交信息（Ctrl+Enter 提交）'}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              if (canCommit) void commit()
            }
          }}
          rows={2}
        />
        <div className="scm-commit-actions">
          <label className="scm-amend" title="修订最近一次提交">
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
            修订
          </label>
          <button className="scm-commit-btn" disabled={!canCommit} onClick={() => void commit()}>
            {busy
              ? '提交中…'
              : commitAll
                ? `提交全部 (${unstaged.length})`
                : `提交${staged.length ? ` (${staged.length})` : ''}`}
          </button>
        </div>
      </div>

      <div className="scm-lists">
        {loading && !status && <div className="scm-empty">加载中…</div>}

        {staged.length > 0 && (
          <div className="scm-section">
            <div className="scm-section-header">
              <span className="scm-section-title">暂存的更改</span>
              <span className="scm-count">{staged.length}</span>
              <button
                className="scm-action scm-section-action"
                title="全部取消暂存"
                onClick={() => void unstageAll()}
              >
                −
              </button>
            </div>
            {staged.map((c) => (
              <ChangeRow key={`s:${c.path}`} change={c} staged />
            ))}
          </div>
        )}

        <div className="scm-section">
          <div className="scm-section-header">
            <span className="scm-section-title">更改</span>
            <span className="scm-count">{unstaged.length}</span>
            {unstaged.length > 0 && (
              <button
                className="scm-action scm-section-action"
                title="暂存所有更改"
                onClick={() => void stageAll()}
              >
                +
              </button>
            )}
          </div>
          {unstaged.map((c) => (
            <ChangeRow key={`u:${c.path}`} change={c} staged={false} />
          ))}
          {unstaged.length === 0 && staged.length === 0 && !loading && (
            <div className="scm-empty">没有更改。</div>
          )}
        </div>
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
