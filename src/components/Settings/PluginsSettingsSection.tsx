import { useCallback, useEffect, useRef, useState } from 'react'
import type { InstalledPluginInfo, PluginInstallResult } from '@shared/pluginTypes'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRow'

function formatInstallResult(res: PluginInstallResult): string {
  if (!res.ok && res.error) return `安装失败：${res.error}`
  const parts: string[] = []
  if (res.pluginName) parts.push(`已安装插件 ${res.pluginName}${res.version ? ` v${res.version}` : ''}`)
  if (res.skills && res.skills.length > 0) parts.push(`技能：${res.skills.join(', ')}`)
  if (res.mcpServers && res.mcpServers.length > 0) parts.push(`MCP 服务：${res.mcpServers.join(', ')}`)
  if ((!res.skills || res.skills.length === 0) && (!res.mcpServers || res.mcpServers.length === 0)) {
    parts.push('未发现可用的技能或 MCP 服务')
  }
  if (res.errors && res.errors.length > 0) parts.push(`错误：${res.errors.join('；')}`)
  return parts.join('。')
}

export default function PluginsSettingsSection(): JSX.Element {
  const workspaceRoot = useWorkspaceStore((s) => s.workspace?.path ?? null)
  const [plugins, setPlugins] = useState<InstalledPluginInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [allowNpmInstall, setAllowNpmInstall] = useState(false)
  const installIdRef = useRef<string | null>(null)

  // 订阅安装进度事件，只显示本组件发起的那次安装。
  useEffect(() => {
    const off = window.lc.plugins.onInstallProgress((p) => {
      if (p.installId !== installIdRef.current) return
      if (p.stage === 'done' || p.stage === 'error') setProgress(null)
      else setProgress(p.message)
    })
    return off
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setPlugins(await window.lc.plugins.list())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void window.lc
      .aiGetAgentSettings()
      .then((s) => setAllowNpmInstall(s.pluginAllowNpmInstall))
      .catch(() => {})
  }, [])

  const handleToggleNpmInstall = (v: boolean): void => {
    setAllowNpmInstall(v)
    void window.lc.aiSaveAgentSettings({ pluginAllowNpmInstall: v }).catch(() => {})
  }

  const handleInstall = async (): Promise<void> => {
    if (!source.trim()) return
    setBusy(true)
    setMsg(null)
    const installId = (crypto?.randomUUID?.() ?? String(Date.now()))
    installIdRef.current = installId
    setProgress('正在准备安装…')
    try {
      const res = await window.lc.plugins.install(source.trim(), workspaceRoot, installId)
      setMsg(formatInstallResult(res))
      if (res.ok) setSource('')
      await load()
    } finally {
      setBusy(false)
      setProgress(null)
      installIdRef.current = null
    }
  }

  const handleUninstall = async (plugin: InstalledPluginInfo): Promise<void> => {
    if (!window.confirm(`确定卸载插件 “${plugin.pluginName}”？将删除其文件并移除注册的 MCP 服务。`)) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await window.lc.plugins.uninstall(plugin.pluginName, workspaceRoot)
      if (!res.ok) setMsg(res.error ?? '卸载失败')
      else setMsg(`已卸载 ${plugin.pluginName}`)
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section-page">
      <SettingsGroup label="已安装的插件">
        {loading && <div className="settings-inline-alert">加载中…</div>}
        {!loading && plugins.length === 0 && (
          <div className="settings-inline-alert">
            尚未安装任何插件。插件需包含 .codex-plugin/plugin.json 或 .claude-plugin/plugin.json 清单。
          </div>
        )}
        {plugins.map((plugin) => (
          <div key={plugin.pluginName} className="skill-card">
            <div className="skill-card-info">
              <div className="skill-card-name">
                <span className="skill-card-title">{plugin.pluginName}</span>
                {plugin.version && <span className="settings-tag">v{plugin.version}</span>}
                {plugin.skills.length > 0 && (
                  <span className="settings-tag">{plugin.skills.length} 技能</span>
                )}
                {plugin.mcpServers.length > 0 && (
                  <span className="settings-tag">{plugin.mcpServers.length} MCP</span>
                )}
              </div>
              {plugin.description && <div className="skill-card-desc">{plugin.description}</div>}
              {plugin.sourceLabel && <div className="skill-card-desc">来源：{plugin.sourceLabel}</div>}
            </div>
            <div className="skill-card-actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => void handleUninstall(plugin)}
              >
                卸载
              </button>
            </div>
          </div>
        ))}
        <div className="settings-actions">
          <button type="button" className="btn-secondary" disabled={busy || loading} onClick={() => void load()}>
            刷新
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup label="通过 Git 安装插件">
        <SettingsRow
          title="允许插件自动安装依赖（npm install）"
          description="开启后，含 package.json 的插件在安装时会自动执行 npm install 及其 postinstall 脚本，以便启动 MCP server。这会运行第三方仓库的任意脚本，存在供应链风险；仅在信任来源时开启。关闭时跳过自动安装，可事后手动安装。"
          stacked
          control={
            <SettingsSwitch
              checked={allowNpmInstall}
              disabled={busy}
              onChange={handleToggleNpmInstall}
            />
          }
        />
        <div className="skill-import">
          <SettingsRow
            title="来源地址"
            description="支持 owner/repo、完整 GitHub 链接、/tree/ 子目录链接，或任意 git 地址。仓库需含 Codex/Claude 插件清单。需要本机已安装 git。"
            stacked
            control={
              <input
                type="text"
                placeholder="例如 zhongerxin/Cowart 或 https://github.com/owner/repo"
                disabled={busy}
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            }
          />
          {progress && (
            <div className="settings-inline-alert">
              <span className="plugin-install-spinner" aria-hidden /> {progress}
            </div>
          )}
          {msg && !progress && <div className="settings-inline-alert">{msg}</div>}
          <div className="skill-import-actions">
            <button type="button" className="btn" disabled={busy || !source.trim()} onClick={() => void handleInstall()}>
              {busy ? '安装中…' : '安装'}
            </button>
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}
