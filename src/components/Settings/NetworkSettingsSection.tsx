import { useCallback, useEffect, useState } from 'react'
import type { NetworkSettings } from '@shared/agentSettings'
import { DEFAULT_NETWORK_SETTINGS } from '@shared/agentSettings'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRow'

export default function NetworkSettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<NetworkSettings | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const s = await window.lc.aiGetNetworkSettings()
    setSettings(s)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (patch: Partial<NetworkSettings>): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.lc.aiSaveNetworkSettings(patch)
      setSettings(next)
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    return (
      <div className="settings-section-page">
        <div className="settings-inline-alert">加载中…</div>
      </div>
    )
  }

  return (
    <div className="settings-section-page">
      <SettingsGroup label="代理配置">
        <SettingsRow
          title="代理地址"
          description="支持 http://host:port，留空则不使用显式代理。"
          stacked
          control={
            <input
              type="text"
              placeholder="http://host:port"
              disabled={saving}
              value={settings.proxyUrl}
              onChange={(e) => setSettings((s) => (s ? { ...s, proxyUrl: e.target.value } : s))}
              onBlur={() => void save({ proxyUrl: settings.proxyUrl })}
            />
          }
        />
        <SettingsRow
          title="回退系统代理"
          description="未设置显式代理时使用操作系统代理配置。"
          control={
            <SettingsSwitch
              disabled={saving}
              checked={settings.useSystemProxy}
              onChange={(v) => void save({ useSystemProxy: v })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup label="证书信任">
        <SettingsRow
          title="自定义 CA 证书路径"
          description="填写 PEM 文件绝对路径，留空则使用系统信任库。"
          stacked
          control={
            <input
              type="text"
              placeholder="C:\\path\\to\\ca.pem"
              disabled={saving}
              value={settings.caCertPath}
              onChange={(e) => setSettings((s) => (s ? { ...s, caCertPath: e.target.value } : s))}
              onBlur={() => void save({ caCertPath: settings.caCertPath })}
            />
          }
        />
      </SettingsGroup>

      <div className="settings-actions">
        <span className="settings-actions-msg">{saving ? '保存中…' : '已同步'}</span>
        <button
          type="button"
          className="btn-secondary"
          disabled={saving}
          onClick={() => void save({ ...DEFAULT_NETWORK_SETTINGS })}
        >
          恢复网络默认
        </button>
      </div>
    </div>
  )
}
