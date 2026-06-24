import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AudioGenSettingsDraft,
  AudioGenSettingsSummary,
  AudioGenTestResult
} from '@shared/agentSettings'
import { AUDIO_VOICES, AUDIO_ENCODINGS, AUDIO_PROVIDERS } from '@shared/agentSettings'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRow'

export default function AudioGenSettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<AudioGenSettingsSummary | null>(null)
  const [saving, setSaving] = useState(false)
  const [baseUrlInput, setBaseUrlInput] = useState('')
  const [modelInput, setModelInput] = useState('')
  const [appidInput, setAppidInput] = useState('')
  const [clusterInput, setClusterInput] = useState('')
  const [groupIdInput, setGroupIdInput] = useState('')
  const [voiceInput, setVoiceInput] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [speedInput, setSpeedInput] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AudioGenTestResult | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const s = await window.lc.aiGetAudioGenSettings()
    setSettings(s)
    setBaseUrlInput(s.baseUrl)
    setModelInput(s.model)
    setAppidInput(s.appid)
    setClusterInput(s.cluster)
    setGroupIdInput(s.groupId)
    setVoiceInput(s.voiceType)
    setSpeedInput(String(s.speed))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (draft: AudioGenSettingsDraft): Promise<void> => {
    setSaving(true)
    try {
      setSettings(await window.lc.aiSaveAudioGenSettings(draft))
    } finally {
      setSaving(false)
    }
  }

  // 切换供应商时，把 baseUrl 一并切到该供应商的默认值（同步本地输入框）。
  const changeProvider = async (provider: string): Promise<void> => {
    const meta = AUDIO_PROVIDERS.find((p) => p.id === provider)
    const nextBaseUrl = meta?.defaultBaseUrl ?? baseUrlInput
    setBaseUrlInput(nextBaseUrl)
    await save({ provider: provider as AudioGenSettingsSummary['provider'], baseUrl: nextBaseUrl })
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.lc.aiTestAudioGen()
      setTestResult(result)
      if (result.ok && result.dataUrl && audioRef.current) {
        audioRef.current.src = result.dataUrl
        void audioRef.current.play().catch(() => undefined)
      }
    } finally {
      setTesting(false)
    }
  }

  if (!settings) {
    return (
      <div className="settings-section-page">
        <div className="settings-inline-alert">加载中…</div>
      </div>
    )
  }

  // 预设音色里若不含当前音色，补一个选项，避免下拉显示空白。
  const voiceOptions = AUDIO_VOICES.some((v) => v.id === settings.voiceType)
    ? AUDIO_VOICES
    : [{ id: settings.voiceType, label: settings.voiceType }, ...AUDIO_VOICES]

  return (
    <div className="settings-section-page">
      <SettingsGroup label="文生音">
        <SettingsRow
          title="启用 GenerateSpeech 工具"
          description="启用后，无论主对话用哪个模型，AI 都能调用下面配置的语音端点把文本合成为语音（文生音）。当前仅支持预设音色，音色克隆将在后续版本提供。"
          control={
            <SettingsSwitch
              id="audiogen-enabled"
              checked={settings.enabled}
              disabled={saving}
              onChange={(v) => void save({ enabled: v })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup label="供应商">
        <SettingsRow
          title="语音供应商"
          description="不同供应商的接口结构不同，选择后会自动套用对应适配器与默认 Base URL。"
          control={
            <select disabled={saving} value={settings.provider} onChange={(e) => void changeProvider(e.target.value)}>
              {AUDIO_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          }
        />
      </SettingsGroup>

      <SettingsGroup label="端点配置">
        <SettingsRow
          title="Base URL"
          description={
            settings.provider === 'volcano'
              ? '火山默认 https://openspeech.bytedance.com，自动追加 /api/v1/tts。'
              : settings.provider === 'openai'
                ? '如 https://api.openai.com/v1，自动追加 /audio/speech。可填兼容网关地址。'
                : '如 https://api.minimax.chat/v1，自动追加 /t2a_v2。'
          }
          stacked
          control={
            <input
              type="text"
              disabled={saving}
              value={baseUrlInput}
              onChange={(e) => setBaseUrlInput(e.target.value)}
              onBlur={() => baseUrlInput !== settings.baseUrl && void save({ baseUrl: baseUrlInput })}
            />
          }
        />
        {(settings.provider === 'openai' || settings.provider === 'minimax') && (
          <SettingsRow
            title="模型名"
            description={settings.provider === 'openai' ? '如 tts-1、gpt-4o-mini-tts。' : '如 speech-01-turbo、speech-02-hd。'}
            stacked
            control={
              <input
                type="text"
                placeholder={settings.provider === 'openai' ? 'tts-1' : 'speech-01-turbo'}
                disabled={saving}
                value={modelInput}
                onChange={(e) => setModelInput(e.target.value)}
                onBlur={() => modelInput !== settings.model && void save({ model: modelInput })}
              />
            }
          />
        )}
        {settings.provider === 'volcano' && (
          <SettingsRow
            title="App ID"
            description="语音控制台应用的 App ID（不是 Ark 接入点 ID）。"
            stacked
            control={
              <input
                type="text"
                placeholder="输入语音 App ID"
                disabled={saving}
                value={appidInput}
                onChange={(e) => setAppidInput(e.target.value)}
                onBlur={() => appidInput !== settings.appid && void save({ appid: appidInput })}
              />
            }
          />
        )}
        {settings.provider === 'volcano' && (
          <SettingsRow
            title="业务集群 Cluster"
            description="如 volcano_tts。"
            stacked
            control={
              <input
                type="text"
                placeholder="volcano_tts"
                disabled={saving}
                value={clusterInput}
                onChange={(e) => setClusterInput(e.target.value)}
                onBlur={() => clusterInput !== settings.cluster && void save({ cluster: clusterInput })}
              />
            }
          />
        )}
        {settings.provider === 'minimax' && (
          <SettingsRow
            title="group_id"
            description="MiniMax 控制台的 GroupId，会作为查询参数附加在请求上。"
            stacked
            control={
              <input
                type="text"
                placeholder="输入 MiniMax group_id"
                disabled={saving}
                value={groupIdInput}
                onChange={(e) => setGroupIdInput(e.target.value)}
                onBlur={() => groupIdInput !== settings.groupId && void save({ groupId: groupIdInput })}
              />
            }
          />
        )}
        <SettingsRow
          title={settings.provider === 'volcano' ? 'Access Token' : 'API Key'}
          description={settings.hasApiKey ? '已配置，输入新值可覆盖。' : settings.provider === 'volcano' ? '使用火山语音的 Access Token 鉴权。' : '使用 Bearer API Key 鉴权。'}
          stacked
          control={
            <input
              type="password"
              placeholder={settings.hasApiKey ? '已配置，输入新值可覆盖' : '输入语音端点 API Key / Token'}
              disabled={saving}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
          }
        />
        <div className="settings-actions">
          <span className="settings-actions-msg">{settings.hasApiKey ? '已配置' : '未配置'}</span>
          <button
            type="button"
            className="btn-secondary"
            disabled={saving || !settings.hasApiKey}
            onClick={() => void save({ apiKey: '' })}
          >
            清除
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
            保存
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup label="合成参数">
        {settings.provider === 'volcano' && (
          <SettingsRow
            title="预设音色"
            description="火山预设音色（voice_type），实际可用列表以账号开通为准。其他音色用下方自定义填写。"
            control={
              <select disabled={saving} value={settings.voiceType} onChange={(e) => void save({ voiceType: e.target.value })}>
                {voiceOptions.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
            }
          />
        )}
        <SettingsRow
          title="音色 ID"
          description={
            settings.provider === 'volcano'
              ? '火山 voice_type，如 zh_female_qingxin。'
              : settings.provider === 'openai'
                ? 'OpenAI voice，如 alloy、echo、nova、shimmer。'
                : 'MiniMax voice_id，如 male-qn-qingse、female-shaonv。'
          }
          stacked
          control={
            <input
              type="text"
              placeholder={settings.provider === 'openai' ? 'alloy' : settings.provider === 'minimax' ? 'male-qn-qingse' : 'zh_female_qingxin'}
              disabled={saving}
              value={voiceInput}
              onChange={(e) => setVoiceInput(e.target.value)}
              onBlur={() => voiceInput.trim() && voiceInput.trim() !== settings.voiceType && void save({ voiceType: voiceInput.trim() })}
            />
          }
        />
        <SettingsRow
          title="默认输出格式"
          control={
            <select disabled={saving} value={settings.encoding} onChange={(e) => void save({ encoding: e.target.value })}>
              {AUDIO_ENCODINGS.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="默认语速"
          description="范围 0.5-2.0，1.0 为正常语速。"
          control={
            <input
              type="number"
              min={0.5}
              max={2}
              step={0.1}
              disabled={saving}
              value={speedInput}
              onChange={(e) => setSpeedInput(e.target.value)}
              onBlur={() => {
                const v = parseFloat(speedInput)
                const s = Number.isFinite(v) ? Math.max(0.5, Math.min(2, Math.round(v * 10) / 10)) : settings.speed
                if (s !== settings.speed) void save({ speed: s })
              }}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup label="连通测试">
        <div className="settings-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={testing || saving || !settings.enabled || !settings.hasApiKey}
            onClick={() => void runTest()}
          >
            {testing ? '合成中…' : '试听一段测试语音'}
          </button>
          {testResult && (
            <span className="settings-actions-msg">
              {testResult.ok
                ? `成功（${testResult.latencyMs ?? 0}ms）`
                : `失败：${testResult.error ?? '未知错误'}`}
            </span>
          )}
        </div>
        <audio ref={audioRef} controls style={{ width: '100%', marginTop: 8 }} />
      </SettingsGroup>
    </div>
  )
}
