import { useCallback, useEffect, useState } from 'react'
import type { EnvCheckResult, EnvToolResult } from '@shared/envCheckTypes'
import { SettingsGroup } from './SettingsRow'

function StatusBadge({ tool }: { tool: EnvToolResult }): JSX.Element {
  if (tool.status === 'installed') {
    return (
      <span className="env-badge env-badge-ok">已安装{tool.version ? ` · ${tool.version}` : ''}</span>
    )
  }
  if (tool.status === 'error') {
    return <span className="env-badge env-badge-err">检测异常</span>
  }
  return <span className="env-badge env-badge-warn">未安装</span>
}

function ToolRow({ tool }: { tool: EnvToolResult }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const installed = tool.status === 'installed'

  const copyCmd = async (): Promise<void> => {
    await window.lc.clipboardWriteText(tool.installCmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="env-tool-row">
      <div className="env-tool-main">
        <div className="env-tool-head">
          <strong>{tool.name}</strong>
          <StatusBadge tool={tool} />
        </div>
        <small className="env-tool-hint">{tool.hint}</small>
        {tool.path && <small className="env-tool-path">{tool.path}</small>}
        {tool.error && <small className="env-tool-error">{tool.error}</small>}
        {!installed && (
          <div className="env-tool-install">
            <code className="env-tool-cmd" title={tool.installCmd}>
              {tool.installCmd}
            </code>
            <button type="button" className="env-mini-btn" onClick={() => void copyCmd()}>
              {copied ? '已复制' : '复制指令'}
            </button>
          </div>
        )}
      </div>
      <div className="env-tool-actions">
        <button
          type="button"
          className="btn-secondary env-install-btn"
          onClick={() => void window.lc.openExternal(tool.installUrl)}
        >
          {installed ? '官网' : '前往安装'}
        </button>
      </div>
    </div>
  )
}

export default function EnvSettingsSection(): JSX.Element {
  const [result, setResult] = useState<EnvCheckResult | null>(null)
  const [loading, setLoading] = useState(false)

  const run = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const r = await window.lc.env.check()
      setResult(r)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void run()
  }, [run])

  const tools = result?.tools ?? []

  return (
    <div className="settings-section-page">
      {result && (
        <div className="env-summary">
          <div className="env-summary-os">
            <span className="env-summary-label">操作系统</span>
            <span>
              {result.osVersion} · {result.arch}
            </span>
          </div>
        </div>
      )}

      {!result && loading && <div className="settings-inline-alert">正在检测环境…</div>}

      {tools.length > 0 && (
        <SettingsGroup label="推荐安装环境">
          {tools.map((t) => (
            <ToolRow key={t.id} tool={t} />
          ))}
        </SettingsGroup>
      )}

      <div className="settings-actions">
        <span className="settings-actions-msg">
          {loading
            ? '检测中…'
            : result
              ? `上次检测 ${new Date(result.checkedAt).toLocaleTimeString()}`
              : ''}
        </span>
        <button type="button" className="btn-secondary" disabled={loading} onClick={() => void run()}>
          重新检测
        </button>
      </div>
    </div>
  )
}
