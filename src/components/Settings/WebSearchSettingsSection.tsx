import { useCallback, useEffect, useState } from 'react'
import type {
  IqsEngineType,
  WebSearchProvider,
  WebSearchSettingsDraft,
  WebSearchSettingsSummary
} from '@shared/agentSettings'
import { SettingsGroup, SettingsRow } from './SettingsRow'

const PROVIDER_OPTIONS: { value: WebSearchProvider; label: string }[] = [
  { value: 'auto', label: '自动（按优先级：阿里云 IQS → Brave → DuckDuckGo）' },
  { value: 'aliyun-iqs', label: '阿里云 IQS' },
  { value: 'brave', label: 'Brave Search' },
  { value: 'duckduckgo', label: 'DuckDuckGo（无需 Key）' }
]

const ENGINE_OPTIONS: { value: IqsEngineType; label: string }[] = [
  { value: 'Generic', label: 'Generic 标准版（约 10 条，免费）' },
  { value: 'GenericAdvanced', label: 'GenericAdvanced 增强版（约 50 条，收费）' },
  { value: 'LiteAdvanced', label: 'LiteAdvanced 极速版（1-50 条，收费）' },
  { value: 'Deep', label: 'Deep 深度搜索（复杂 query，收费）' }
]

const PROVIDER_LABEL: Record<Exclude<WebSearchProvider, 'auto'>, string> = {
  'aliyun-iqs': '阿里云 IQS',
  brave: 'Brave Search',
  duckduckgo: 'DuckDuckGo'
}

export default function WebSearchSettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<WebSearchSettingsSummary | null>(null)
  const [saving, setSaving] = useState(false)
  const [iqsKeyInput, setIqsKeyInput] = useState('')
  const [braveKeyInput, setBraveKeyInput] = useState('')

  const load = useCallback(async (): Promise<void> => {
    const s = await window.lc.aiGetWebSearchSettings()
    setSettings(s)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (draft: WebSearchSettingsDraft): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.lc.aiSaveWebSearchSettings(draft)
      setSettings(next)
    } finally {
      setSaving(false)
    }
  }

  const saveIqsKey = async (): Promise<void> => {
    if (!iqsKeyInput) return
    await save({ iqsApiKey: iqsKeyInput })
    setIqsKeyInput('')
  }

  const saveBraveKey = async (): Promise<void> => {
    if (!braveKeyInput) return
    await save({ braveApiKey: braveKeyInput })
    setBraveKeyInput('')
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
      <SettingsGroup label="服务选择">
        <SettingsRow
          title="搜索服务"
          description="可固定使用某个服务，或交给自动模式按优先级选择。"
          stacked
          control={
            <select
              disabled={saving}
              value={settings.provider}
              onChange={(e) => void save({ provider: e.target.value as WebSearchProvider })}
            >
              {PROVIDER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="阿里云 IQS 引擎类型"
          description="Generic 为免费标准版，其余为收费选项。"
          stacked
          control={
            <select
              disabled={saving}
              value={settings.iqsEngineType}
              onChange={(e) => void save({ iqsEngineType: e.target.value as IqsEngineType })}
            >
              {ENGINE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="当前生效"
          control={<span className="settings-tag on">{PROVIDER_LABEL[settings.effectiveProvider]}</span>}
        />
      </SettingsGroup>

      <SettingsGroup label="阿里云 IQS">
        <SettingsRow
          title="API Key"
          description={settings.hasIqsKey ? 'Key 已配置，输入新值可覆盖。' : '使用 Bearer Token 鉴权。'}
          stacked
          control={
            <input
              type="password"
              placeholder={settings.hasIqsKey ? '已配置，输入新值可覆盖' : '输入阿里云 IQS API Key'}
              disabled={saving}
              value={iqsKeyInput}
              onChange={(e) => setIqsKeyInput(e.target.value)}
            />
          }
        />
        <div className="settings-actions">
          <span className="settings-actions-msg">{settings.hasIqsKey ? 'Key 已配置' : '未配置'}</span>
          <button type="button" className="btn-secondary" disabled={saving || !settings.hasIqsKey} onClick={() => void save({ iqsApiKey: '' })}>
            清除 Key
          </button>
          <button type="button" className="btn" disabled={saving || !iqsKeyInput} onClick={() => void saveIqsKey()}>
            保存 Key
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup label="Brave Search">
        <SettingsRow
          title="API Key"
          description={settings.hasBraveKey ? 'Key 已配置，输入新值可覆盖。' : '使用 X-Subscription-Token 鉴权。'}
          stacked
          control={
            <input
              type="password"
              placeholder={settings.hasBraveKey ? '已配置，输入新值可覆盖' : '输入 Brave Search API Key'}
              disabled={saving}
              value={braveKeyInput}
              onChange={(e) => setBraveKeyInput(e.target.value)}
            />
          }
        />
        <div className="settings-actions">
          <span className="settings-actions-msg">{settings.hasBraveKey ? 'Key 已配置' : '未配置'}</span>
          <button type="button" className="btn-secondary" disabled={saving || !settings.hasBraveKey} onClick={() => void save({ braveApiKey: '' })}>
            清除 Key
          </button>
          <button type="button" className="btn" disabled={saving || !braveKeyInput} onClick={() => void saveBraveKey()}>
            保存 Key
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup label="DuckDuckGo">
        <SettingsRow
          title="兜底搜索"
          description="无需 API Key，稳定性低于上述付费服务。"
          control={<span className="settings-tag on">无需 Key</span>}
        />
      </SettingsGroup>
    </div>
  )
}
