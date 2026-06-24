import { useCallback, useEffect, useState } from 'react'
import type {
  VideoGenSettingsDraft,
  VideoGenSettingsSummary
} from '@shared/agentSettings'
import { VIDEO_RESOLUTIONS, VIDEO_RATIOS } from '@shared/agentSettings'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRow'

export default function VideoGenSettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<VideoGenSettingsSummary | null>(null)
  const [saving, setSaving] = useState(false)
  const [baseUrlInput, setBaseUrlInput] = useState('')
  const [modelInput, setModelInput] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [durationInput, setDurationInput] = useState('')
  const [timeoutInput, setTimeoutInput] = useState('')

  const load = useCallback(async (): Promise<void> => {
    const s = await window.lc.aiGetVideoGenSettings()
    setSettings(s)
    setBaseUrlInput(s.baseUrl)
    setModelInput(s.model)
    setDurationInput(String(s.duration))
    setTimeoutInput(String(Math.round(s.pollTimeoutMs / 1000)))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (draft: VideoGenSettingsDraft): Promise<void> => {
    setSaving(true)
    try {
      setSettings(await window.lc.aiSaveVideoGenSettings(draft))
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
      <SettingsGroup label="视频生成">
        <SettingsRow
          title="启用 GenerateVideo 工具"
          description="启用后，无论主对话用哪个模型，AI 都能调用下面配置的视频端点生成视频（文生视频 / 图生视频）。"
          control={
            <SettingsSwitch
              id="videogen-enabled"
              checked={settings.enabled}
              disabled={saving}
              onChange={(v) => void save({ enabled: v })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup label="端点配置（火山方舟 Seedance 兼容）">
        <SettingsRow
          title="Base URL"
          description="如 https://ark.cn-beijing.volces.com/api/v3，会自动追加 /contents/generations/tasks。"
          stacked
          control={
            <input
              type="text"
              placeholder="https://ark.cn-beijing.volces.com/api/v3"
              disabled={saving}
              value={baseUrlInput}
              onChange={(e) => setBaseUrlInput(e.target.value)}
              onBlur={() => baseUrlInput !== settings.baseUrl && void save({ baseUrl: baseUrlInput })}
            />
          }
        />
        <SettingsRow
          title="模型名 / 接入点 ID"
          description="如 doubao-seedance-1-5-pro-251215，或推理接入点 ID（ep-xxx）。"
          stacked
          control={
            <input
              type="text"
              placeholder="doubao-seedance-1-5-pro-251215"
              disabled={saving}
              value={modelInput}
              onChange={(e) => setModelInput(e.target.value)}
              onBlur={() => modelInput !== settings.model && void save({ model: modelInput })}
            />
          }
        />
        <SettingsRow
          title="API Key"
          description={settings.hasApiKey ? 'Key 已配置，输入新值可覆盖。' : '使用 Bearer Token 鉴权。'}
          stacked
          control={
            <input
              type="password"
              placeholder={settings.hasApiKey ? '已配置，输入新值可覆盖' : '输入视频端点 API Key'}
              disabled={saving}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
          }
        />
        <div className="settings-actions">
          <span className="settings-actions-msg">{settings.hasApiKey ? 'Key 已配置' : '未配置'}</span>
          <button
            type="button"
            className="btn-secondary"
            disabled={saving || !settings.hasApiKey}
            onClick={() => void save({ apiKey: '' })}
          >
            清除 Key
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={saving || !keyInput}
            onClick={() => {
              void save({ apiKey: keyInput })
              setKeyInput('')
            }}
          >
            保存 Key
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup label="生成参数">
        <SettingsRow
          title="默认分辨率"
          control={
            <select disabled={saving} value={settings.resolution} onChange={(e) => void save({ resolution: e.target.value })}>
              {VIDEO_RESOLUTIONS.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="默认画面比例"
          control={
            <select disabled={saving} value={settings.ratio} onChange={(e) => void save({ ratio: e.target.value })}>
              {VIDEO_RATIOS.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="默认时长（秒）"
          description="范围 1-30，常用 5。具体可用值取决于模型。"
          control={
            <input
              type="number"
              min={1}
              max={30}
              disabled={saving}
              value={durationInput}
              onChange={(e) => setDurationInput(e.target.value)}
              onBlur={() => {
                const v = parseInt(durationInput, 10)
                const d = Number.isFinite(v) ? Math.max(1, Math.min(30, v)) : settings.duration
                if (d !== settings.duration) void save({ duration: d })
              }}
            />
          }
        />
        <SettingsRow
          title="生成音频"
          description="部分模型支持有声视频，通常加价。"
          control={
            <SettingsSwitch
              id="videogen-audio"
              checked={settings.generateAudio}
              disabled={saving}
              onChange={(v) => void save({ generateAudio: v })}
            />
          }
        />
        <SettingsRow
          title="AI 水印"
          control={
            <SettingsSwitch
              id="videogen-watermark"
              checked={settings.watermark}
              disabled={saving}
              onChange={(v) => void save({ watermark: v })}
            />
          }
        />
        <SettingsRow
          title="轮询超时（秒）"
          description="视频生成为异步任务，较慢。范围 30-1800，默认 600。"
          control={
            <input
              type="number"
              min={30}
              max={1800}
              disabled={saving}
              value={timeoutInput}
              onChange={(e) => setTimeoutInput(e.target.value)}
              onBlur={() => {
                const secs = parseInt(timeoutInput, 10)
                const ms = Number.isFinite(secs) ? Math.max(30, Math.min(1800, secs)) * 1000 : settings.pollTimeoutMs
                if (ms !== settings.pollTimeoutMs) void save({ pollTimeoutMs: ms })
              }}
            />
          }
        />
      </SettingsGroup>
    </div>
  )
}
