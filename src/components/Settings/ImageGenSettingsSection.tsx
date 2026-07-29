import { useCallback, useEffect, useState } from 'react'
import type {
  ImageGenSettingsDraft,
  ImageGenSettingsSummary,
  ImageGenTestResult
} from '@shared/agentSettings'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRow'
import { isDashScopeEndpoint, isVolcEndpoint } from '@shared/appConfig'

const OPENAI_COMPAT_SIZE_OPTIONS = ['1024x1024', '1024x1536', '1536x1024', 'auto']
const VOLC_SIZE_OPTIONS = ['2K', '4K', '2048x2048', '2304x1728', '1728x2304']
// 阿里云 DashScope 用 “宽*高” 形式，且不认 auto/档位关键字。
const DASHSCOPE_SIZE_OPTIONS = ['1024*1024', '1536*1024', '1024*1536', '1280*720', '720*1280', '2048*2048']

export default function ImageGenSettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<ImageGenSettingsSummary | null>(null)
  const [saving, setSaving] = useState(false)
  const [baseUrlInput, setBaseUrlInput] = useState('')
  const [modelInput, setModelInput] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [timeoutInput, setTimeoutInput] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ImageGenTestResult | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const s = await window.lc.aiGetImageGenSettings()
    setSettings(s)
    setBaseUrlInput(s.baseUrl)
    setModelInput(s.model)
    setTimeoutInput(String(Math.round(s.timeoutMs / 1000)))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (draft: ImageGenSettingsDraft): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.lc.aiSaveImageGenSettings(draft)
      setSettings(next)
      setTestResult(null)
    } finally {
      setSaving(false)
    }
  }

  const onTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await window.lc.aiTestImageGen())
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

  // 根据「当前正在编辑」的 Base URL 判断端点类型，实时切换提示与尺寸选项。
  const editedBaseUrl = baseUrlInput || settings.baseUrl
  const isDashScope = isDashScopeEndpoint(editedBaseUrl)
  const isVolc = isVolcEndpoint(editedBaseUrl)
  const sizeOptions = isDashScope
    ? DASHSCOPE_SIZE_OPTIONS
    : isVolc
      ? VOLC_SIZE_OPTIONS
      : OPENAI_COMPAT_SIZE_OPTIONS
  const endpointGroupLabel = isDashScope
    ? '端点配置（阿里云 DashScope / 百炼多模态生成）'
    : isVolc
      ? '端点配置（火山方舟 Seedream）'
      : '端点配置（OpenAI Images API 兼容）'

  return (
    <div className="settings-section-page">
      <SettingsGroup label="图像生成">
        <SettingsRow
          title="启用 GenerateImage 工具"
          description="启用后，无论主对话用哪个模型，AI 都能调用下面配置的图像端点出图。"
          control={
            <SettingsSwitch
              id="imagegen-enabled"
              checked={settings.enabled}
              disabled={saving}
              onChange={(v) => void save({ enabled: v })}
            />
          }
        />
        <SettingsRow
          title="AI 水印"
          description="仅对火山方舟（Ark）端点生效：开启则给图片加 AI 生成水印，关闭则请求 watermark=false。非火山端点会自动忽略此项，不会发送该字段。"
          control={
            <SettingsSwitch
              id="imagegen-watermark"
              checked={settings.watermark}
              disabled={saving}
              onChange={(v) => void save({ watermark: v })}
            />
          }
        />
      </SettingsGroup>

      {isDashScope && (
        <div className="settings-inline-alert">
          已识别为阿里云端点：将改用 DashScope 原生多模态生成协议（
          <code>/services/aigc/multimodal-generation/generation</code>），而非 OpenAI Images API。Base URL 可填
          <code>https://dashscope.aliyuncs.com</code> 或 MaaS 专属地址，模型名如
          <code>qwen-image-2.0-pro-2026-06-22</code>。
        </div>
      )}

      {isVolc && !isDashScope && (
        <div className="settings-inline-alert">
          已识别为火山方舟端点：可使用 <code>2K</code> / <code>4K</code> 档位、AI 水印和 Seedream 组图参数。
        </div>
      )}

      {!isDashScope && !isVolc && settings.size.toUpperCase() === '2K' && (
        <div className="settings-inline-alert">
          当前看起来是普通 OpenAI 兼容网关，建议默认尺寸改为 <code>1024x1024</code>、竖图用
          <code>1024x1536</code>、横图用 <code>1536x1024</code>；<code>2K</code> 可能不是该网关支持的格式。
        </div>
      )}

      <SettingsGroup label={endpointGroupLabel}>
        <SettingsRow
          title="Base URL"
          description={
            isDashScope
              ? '阿里云：填 https://dashscope.aliyuncs.com 或 MaaS 专属域名即可，会自动补全多模态生成路径。'
              : isVolc
                ? '火山方舟：填 Ark / Seedream 接入地址，会使用火山图像参数。'
                : '如 https://api.openai.com/v1，会自动追加 /images/generations。第三方兼容网关也按通用 OpenAI Images 参数调用。'
          }
          stacked
          control={
            <input
              type="text"
              placeholder="https://api.openai.com/v1"
              disabled={saving}
              value={baseUrlInput}
              onChange={(e) => setBaseUrlInput(e.target.value)}
              onBlur={() => baseUrlInput !== settings.baseUrl && void save({ baseUrl: baseUrlInput })}
            />
          }
        />
        <SettingsRow
          title="模型名"
          description={
            isDashScope
              ? '阿里云文生图模型，如 qwen-image-2.0-pro-2026-06-22、wanx2.1-t2i-turbo 等。'
              : isVolc
                ? '火山 Seedream 模型名或接入点 ID。'
                : '如 gpt-image-1、gpt-image-2、dall-e-3，或第三方网关的文生图模型名。'
          }
          stacked
          control={
            <input
              type="text"
              placeholder={isDashScope ? 'qwen-image-2.0-pro-2026-06-22' : 'gpt-image-1'}
              disabled={saving}
              value={modelInput}
              onChange={(e) => setModelInput(e.target.value)}
              onBlur={() => modelInput !== settings.model && void save({ model: modelInput })}
            />
          }
        />
        <SettingsRow
          title="默认尺寸"
          description={
            isDashScope
              ? '阿里云用「宽*高」形式，如 1536*1024。'
              : isVolc
                ? '火山 Seedream 可用 2K/4K；普通宽高也会按火山规则规整。'
                : '普通 OpenAI 兼容网关建议用 1024x1024、1024x1536 或 1536x1024；模型调用工具时也可按场景覆盖。'
          }
          control={
            <select
              disabled={saving}
              value={settings.size}
              onChange={(e) => void save({ size: e.target.value })}
            >
              {!sizeOptions.includes(settings.size) && (
                <option value={settings.size}>{settings.size}</option>
              )}
              {sizeOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="请求超时（秒）"
          description="图像生成/编辑较慢，gpt-image 系列编辑常需 1~2 分钟。范围 10-600，默认 180。"
          control={
            <input
              type="number"
              min={10}
              max={600}
              disabled={saving}
              value={timeoutInput}
              onChange={(e) => setTimeoutInput(e.target.value)}
              onBlur={() => {
                const secs = parseInt(timeoutInput, 10)
                const ms = Number.isFinite(secs) ? Math.max(10, Math.min(600, secs)) * 1000 : settings.timeoutMs
                if (ms !== settings.timeoutMs) void save({ timeoutMs: ms })
              }}
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
              placeholder={settings.hasApiKey ? '已配置，输入新值可覆盖' : '输入图像端点 API Key'}
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
          <button
            type="button"
            className="btn"
            disabled={testing || !settings.enabled || !settings.baseUrl || !settings.hasApiKey}
            onClick={() => void onTest()}
          >
            {testing ? '生成中…' : '测试生成'}
          </button>
        </div>

        {testResult && (
          <div className={`settings-imgtest ${testResult.ok ? 'ok' : 'err'}`}>
            {testResult.ok ? (
              <>
                <div className="settings-imgtest-msg">生成成功 · {testResult.latencyMs ?? '?'}ms</div>
                {testResult.dataUrl && (
                  <img className="settings-imgtest-img" src={testResult.dataUrl} alt="测试生成的图片" />
                )}
              </>
            ) : (
              <div className="settings-imgtest-msg">生成失败：{testResult.error ?? '未知错误'}</div>
            )}
          </div>
        )}
      </SettingsGroup>
    </div>
  )
}
