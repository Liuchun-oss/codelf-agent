import { useCallback, useEffect, useState } from 'react'
import type { AuditEntry, DebugEventRecord } from '@shared/agentTypes'

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString()
  } catch {
    return iso
  }
}

const KIND_LABEL: Record<DebugEventRecord['kind'], string> = {
  request_start: '请求开始',
  request_end: '请求结束',
  request_error: '请求错误',
  tool_call: '工具调用',
  compact: '上下文压缩'
}

const ACTION_LABEL: Record<AuditEntry['action'], string> = {
  write: '写入',
  edit: '编辑',
  create: '创建',
  delete: '删除',
  terminal: '终端'
}

export default function DebugPanelSection(): JSX.Element {
  const [tab, setTab] = useState<'events' | 'audit'>('events')
  const [events, setEvents] = useState<DebugEventRecord[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [ev, au] = await Promise.all([
        window.lc.aiReadDebugEvents(200),
        window.lc.aiReadAudit(200)
      ])
      setEvents(ev)
      setAudit(au)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="settings-section-page">
      <div className="settings-card diagnostics-card">
        <div className="debug-panel-tabs">
          <button
            type="button"
            className={`debug-panel-tab${tab === 'events' ? ' active' : ''}`}
            onClick={() => setTab('events')}
          >
            调试事件 <span>{events.length}</span>
          </button>
          <button
            type="button"
            className={`debug-panel-tab${tab === 'audit' ? ' active' : ''}`}
            onClick={() => setTab('audit')}
          >
            审计日志 <span>{audit.length}</span>
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="btn-secondary debug-panel-refresh"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>

        <p className="settings-hint">
          调试事件为内存缓冲，重启清空；审计日志持久化于 <code>userData/audit.log</code>。
        </p>

        {tab === 'events' ? (
          <div className="debug-panel-list" role="log">
            {events.length === 0 ? (
              <div className="debug-panel-empty">暂无事件</div>
            ) : (
              events.map((e, i) => (
                <div key={i} className={`debug-panel-row kind-${e.kind}`}>
                  <span className="debug-panel-time">{fmtTime(e.ts)}</span>
                  <span className="debug-panel-kind">{KIND_LABEL[e.kind] ?? e.kind}</span>
                  <span className="debug-panel-label">{e.label ?? ''}</span>
                  {e.durationMs !== undefined && (
                    <span className="debug-panel-dur">{e.durationMs}ms</span>
                  )}
                  {e.detail && <span className="debug-panel-detail">{e.detail}</span>}
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="debug-panel-list" role="log">
            {audit.length === 0 ? (
              <div className="debug-panel-empty">暂无审计记录</div>
            ) : (
              audit.map((a, i) => (
                <div key={i} className={`debug-panel-row action-${a.action}`}>
                  <span className="debug-panel-time">{fmtTime(a.ts)}</span>
                  <span className="debug-panel-kind">{ACTION_LABEL[a.action] ?? a.action}</span>
                  <span className="debug-panel-label">{a.tool}</span>
                  <span className="debug-panel-detail">{a.command ?? a.path ?? ''}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
