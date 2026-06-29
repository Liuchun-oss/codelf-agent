import { useEffect, useState, useCallback } from 'react'
import type {
  ProviderKind,
  ProviderProfileSummary,
  ProfileDraft,
  TestConnectionResult,
  TestImageGenResult
} from '@shared/agentTypes'
import { useAgentStore } from '@/stores/agentStore'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRow'
import UsageStatsModal from './UsageStatsModal'

const KIND_LABEL: Record<ProviderKind, string> = {
  openai: 'OpenAI',
  'azure-openai': 'Azure OpenAI',
  anthropic: 'Anthropic',
  'openai-compatible': 'OpenAI 兼容',
  deepseek: 'DeepSeek',
  dify: 'Dify'
}

const DEFAULT_BASE_URL: Record<ProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  'azure-openai': 'https://<resource>.openai.azure.com',
  anthropic: 'https://api.anthropic.com',
  'openai-compatible': 'https://api.deepseek.com/v1',
  deepseek: 'https://api.deepseek.com',
  dify: 'http://127.0.0.1/v1'
}

interface DraftForm {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  model: string
  apiKey: string
  contextWindow: string
  maxOutputTokens: string
  supportsTools: boolean
  supportsVision: boolean
  timeoutMs: string
  azureDeployment: string
  azureApiVersion: string
  thinkingMode: boolean
  reasoningEffort: 'high' | 'max'
  fimEnabled: boolean
  imageGeneration: boolean
}

function blankDraft(): DraftForm {
  return {
    id: crypto.randomUUID(),
    name: '新配置',
    kind: 'deepseek',
    baseUrl: DEFAULT_BASE_URL['deepseek'],
    model: 'deepseek-v4-pro',
    apiKey: '',
    contextWindow: '',
    maxOutputTokens: '',
    supportsTools: true,
    supportsVision: false,
    timeoutMs: '120000',
    azureDeployment: '',
    azureApiVersion: '',
    thinkingMode: true,
    reasoningEffort: 'high',
    fimEnabled: false,
    imageGeneration: false
  }
}

function fromSummary(p: ProviderProfileSummary): DraftForm {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: '',
    contextWindow: p.contextWindow != null ? String(p.contextWindow) : '',
    maxOutputTokens: p.maxOutputTokens != null ? String(p.maxOutputTokens) : '',
    supportsTools: p.supportsTools,
    supportsVision: p.supportsVision ?? false,
    timeoutMs: String(p.timeoutMs ?? 120000),
    azureDeployment: p.azureDeployment ?? '',
    azureApiVersion: p.azureApiVersion ?? '',
    thinkingMode: p.thinkingMode ? p.thinkingMode === 'enabled' : true,
    reasoningEffort: p.reasoningEffort ?? 'high',
    fimEnabled: p.fimEnabled ?? false,
    imageGeneration: p.imageGeneration ?? false
  }
}

function parseOptInt(s: string): number | undefined {
  const n = parseInt(s, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function buildDraft(f: DraftForm, includeTypedKey: boolean): ProfileDraft {
  const cw = parseOptInt(f.contextWindow)
  const mo = parseOptInt(f.maxOutputTokens)
  return {
    id: f.id,
    name: f.name.trim(),
    kind: f.kind,
    baseUrl: f.baseUrl.trim(),
    model: f.model.trim(),
    contextWindow: cw,
    contextWindowSource: cw != null ? 'manual' : 'default',
    maxOutputTokens: mo,
    maxOutputTokensSource: mo != null ? 'manual' : 'default',
    supportsTools: f.supportsTools,
    supportsVision: f.supportsVision,
    timeoutMs: parseOptInt(f.timeoutMs) ?? 120000,
    azureDeployment: f.kind === 'azure-openai' ? f.azureDeployment.trim() || undefined : undefined,
    azureApiVersion: f.kind === 'azure-openai' ? f.azureApiVersion.trim() || undefined : undefined,
    thinkingMode: f.kind === 'deepseek' ? (f.thinkingMode ? 'enabled' : 'disabled') : undefined,
    reasoningEffort: f.kind === 'deepseek' && f.thinkingMode ? f.reasoningEffort : undefined,
    fimEnabled: f.kind === 'deepseek' ? f.fimEnabled : undefined,
    imageGeneration: (f.kind === 'openai' || f.kind === 'openai-compatible') ? f.imageGeneration : undefined,
    apiKey: includeTypedKey && f.apiKey !== '' ? f.apiKey : undefined
  }
}

export default function AiSettingsSection(): JSX.Element {
  const [profiles, setProfiles] = useState<ProviderProfileSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [form, setForm] = useState<DraftForm>(blankDraft())
  const [editingHasKey, setEditingHasKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)
  const [imgTesting, setImgTesting] = useState(false)
  const [imgTestResult, setImgTestResult] = useState<TestImageGenResult | null>(null)
  const [secureAvailable, setSecureAvailable] = useState(true)
  const [showUsage, setShowUsage] = useState(false)

  const refresh = useCallback(async (selectId?: string) => {
    const [list, active, secure] = await Promise.all([
      window.lc.aiListProfiles(),
      window.lc.aiGetActiveProfile(),
      window.lc.secretsIsAvailable()
    ])
    setProfiles(list)
    setActiveId(active?.id ?? null)
    setSecureAvailable(secure)
    const target = selectId ? list.find((p) => p.id === selectId) : list.find((p) => p.id === form.id)
    if (target) {
      setForm(fromSummary(target))
      setEditingHasKey(target.hasApiKey)
    }
    void useAgentStore.getState().refreshActiveProfile()
  }, [form.id])

  useEffect(() => {
    void (async () => {
      const [list, active, secure] = await Promise.all([
        window.lc.aiListProfiles(),
        window.lc.aiGetActiveProfile(),
        window.lc.secretsIsAvailable()
      ])
      setProfiles(list)
      setActiveId(active?.id ?? null)
      setSecureAvailable(secure)
      if (list.length > 0) {
        const sel = list.find((p) => p.id === active?.id) ?? list[0]
        setForm(fromSummary(sel))
        setEditingHasKey(sel.hasApiKey)
      }
    })()
  }, [])

  const patch = (p: Partial<DraftForm>): void => {
    setForm((f) => ({ ...f, ...p }))
    setTestResult(null)
    setImgTestResult(null)
  }

  const selectProfile = (id: string): void => {
    if (id === '__new__') {
      setForm(blankDraft())
      setEditingHasKey(false)
      setTestResult(null)
      return
    }
    const p = profiles.find((x) => x.id === id)
    if (p) {
      setForm(fromSummary(p))
      setEditingHasKey(p.hasApiKey)
      setTestResult(null)
    }
  }

  const onSave = async (): Promise<void> => {
    const res = await window.lc.aiSaveProfile(buildDraft(form, true))
    if (!res.ok) {
      setTestResult({ ok: false, error: res.error ?? '保存失败' })
      return
    }
    const wasEmpty = profiles.length === 0
    if (wasEmpty) await window.lc.aiSetActiveProfile(form.id)
    await refresh(form.id)
  }

  const onDelete = async (): Promise<void> => {
    const exists = profiles.some((p) => p.id === form.id)
    if (!exists) {
      setForm(blankDraft())
      return
    }
    await window.lc.aiDeleteProfile(form.id)
    const remaining = profiles.filter((p) => p.id !== form.id)
    if (remaining.length > 0) {
      setForm(fromSummary(remaining[0]))
      setEditingHasKey(remaining[0].hasApiKey)
    } else {
      setForm(blankDraft())
      setEditingHasKey(false)
    }
    await refresh(remaining[0]?.id)
  }

  const onSetActive = async (): Promise<void> => {
    const exists = profiles.some((p) => p.id === form.id)
    if (!exists) return
    await window.lc.aiSetActiveProfile(form.id)
    await refresh(form.id)
  }

  const onTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.lc.aiTestConnection(buildDraft(form, true))
      setTestResult(result)
      if (result.ok) {
        setForm((f) => ({
          ...f,
          contextWindow: result.contextWindow != null ? String(result.contextWindow) : f.contextWindow,
          maxOutputTokens:
            result.maxOutputTokens != null ? String(result.maxOutputTokens) : f.maxOutputTokens,
          supportsTools: result.supportsTools ?? f.supportsTools
        }))
      }
    } finally {
      setTesting(false)
    }
  }

  const onTestImage = async (): Promise<void> => {
    setImgTesting(true)
    setImgTestResult(null)
    try {
      const result = await window.lc.aiTestImageGeneration(buildDraft(form, true))
      setImgTestResult(result)
    } finally {
      setImgTesting(false)
    }
  }

  const profileExists = profiles.some((p) => p.id === form.id)
  const isActive = activeId === form.id && profileExists
  const credentialState = editingHasKey || form.apiKey ? 'Key 已配置' : '无 Key'
  const resultText = testResult
    ? testResult.ok
      ? `连接成功 · ${testResult.latencyMs ?? '?'}ms · 工具：${testResult.supportsTools ? '支持' : '不确定/不支持'}` +
        (testResult.balanceTotal != null
          ? ` · 余额：${testResult.balanceCurrency === 'USD' ? '$' : '¥'}${testResult.balanceTotal}${testResult.balanceAvailable === false ? '（不足）' : ''}`
          : '')
      : testResult.error ?? '连接失败'
    : '未测试'
  const balanceLow = testResult?.ok === true && testResult.balanceAvailable === false

  return (
    <div className="settings-section-page settings-ai-section">
      <div className="settings-ai-bar">
        <select
          value={profileExists ? form.id : '__new__'}
          onChange={(e) => selectProfile(e.target.value)}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.id === activeId ? '（当前）' : ''}
            </option>
          ))}
          <option value="__new__">+ 新建配置…</option>
        </select>
        <div className="settings-ai-bar-spacer" />
        <div className="settings-ai-tags">
          <span className={`settings-tag${isActive ? ' on' : ''}`}>{isActive ? '当前激活' : '未激活'}</span>
          <span className={`settings-tag${editingHasKey || form.apiKey ? ' on' : ''}`}>{credentialState}</span>
        </div>
      </div>

      {!secureAvailable && (
        <div className="settings-inline-alert">
          当前系统不支持 safeStorage，无法保存 API Key。可改用本地无 Key Provider。
        </div>
      )}

      <SettingsGroup label="基本">
        <SettingsRow
          title="名称"
          control={<input type="text" value={form.name} onChange={(e) => patch({ name: e.target.value })} />}
        />
        <SettingsRow
          title="类型"
          control={
            <select
              value={form.kind}
              onChange={(e) => {
                const kind = e.target.value as ProviderKind
                patch({ kind, baseUrl: form.baseUrl || DEFAULT_BASE_URL[kind] })
              }}
            >
              {(Object.keys(KIND_LABEL) as ProviderKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="模型名"
          control={<input type="text" value={form.model} onChange={(e) => patch({ model: e.target.value })} />}
        />
      </SettingsGroup>

      <SettingsGroup label="连接">
        <SettingsRow
          title="Base URL"
          control={<input type="text" value={form.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} />}
        />
        <SettingsRow
          title="API Key"
          control={
            <input
              type="password"
              value={form.apiKey}
              placeholder={editingHasKey ? '已配置，留空保持不变' : '输入 API Key，本地模型可留空'}
              onChange={(e) => patch({ apiKey: e.target.value })}
            />
          }
        />
        {form.kind === 'azure-openai' && (
          <>
            <SettingsRow
              title="Azure Deployment"
              control={
                <input
                  type="text"
                  value={form.azureDeployment}
                  onChange={(e) => patch({ azureDeployment: e.target.value })}
                />
              }
            />
            <SettingsRow
              title="Azure API Version"
              control={
                <input
                  type="text"
                  value={form.azureApiVersion}
                  placeholder="2024-02-15-preview"
                  onChange={(e) => patch({ azureApiVersion: e.target.value })}
                />
              }
            />
          </>
        )}
      </SettingsGroup>

      <SettingsGroup label="参数">
        <SettingsRow
          title="上下文窗口"
          description="留空（自动）则自动探测。"
          control={
            <select value={form.contextWindow} onChange={(e) => patch({ contextWindow: e.target.value })}>
              <option value="">自动</option>
              <option value="128000">128K</option>
              <option value="200000">200K</option>
              <option value="300000">300K</option>
              <option value="1000000">1M</option>
              {form.contextWindow !== '' &&
                !['128000', '200000', '300000', '1000000'].includes(form.contextWindow) && (
                  <option value={form.contextWindow}>{`${form.contextWindow}（自定义）`}</option>
                )}
            </select>
          }
        />
        <SettingsRow
          title="最大输出 Token"
          control={
            <input
              type="number"
              value={form.maxOutputTokens}
              placeholder="默认"
              onChange={(e) => patch({ maxOutputTokens: e.target.value })}
            />
          }
        />
        <SettingsRow
          title="请求超时 (ms)"
          control={
            <input type="number" value={form.timeoutMs} onChange={(e) => patch({ timeoutMs: e.target.value })} />
          }
        />
      </SettingsGroup>

      <SettingsGroup label="能力">
        <SettingsRow
          title="工具调用"
          control={
            <SettingsSwitch
              id="ai-supports-tools"
              checked={form.supportsTools}
              onChange={(v) => patch({ supportsTools: v })}
            />
          }
        />
        <SettingsRow
          title="图片输入"
          control={
            <SettingsSwitch
              id="ai-supports-vision"
              checked={form.supportsVision}
              onChange={(v) => patch({ supportsVision: v })}
            />
          }
        />
        {(form.kind === 'openai' || form.kind === 'openai-compatible') && (
          <SettingsRow
            title="图像生成 (Responses API)"
            description="启用后改走 OpenAI Responses API，模型可在对话中直接生成图片。需端点支持 /v1/responses 与 image_generation 工具。"
            control={
              <SettingsSwitch
                id="ai-image-generation"
                checked={form.imageGeneration}
                onChange={(v) => patch({ imageGeneration: v })}
              />
            }
          />
        )}
      </SettingsGroup>

      {form.kind === 'deepseek' && (
        <SettingsGroup label="思考模式">
          <SettingsRow
            title="开启思考"
            control={
              <SettingsSwitch
                id="ai-thinking-mode"
                checked={form.thinkingMode}
                onChange={(v) => patch({ thinkingMode: v })}
              />
            }
          />
          <SettingsRow
            title="思考强度"
            control={
              <select
                value={form.reasoningEffort}
                disabled={!form.thinkingMode}
                onChange={(e) => patch({ reasoningEffort: e.target.value as 'high' | 'max' })}
              >
                <option value="high">high</option>
                <option value="max">max</option>
              </select>
            }
          />
          <SettingsRow
            title="Tab 补全 (FIM)"
            control={
              <SettingsSwitch
                id="ai-fim-enabled"
                checked={form.fimEnabled}
                onChange={(v) => patch({ fimEnabled: v })}
              />
            }
          />
        </SettingsGroup>
      )}

      <div className="settings-actions">
        <span className={`settings-actions-msg ${testResult ? (balanceLow ? 'err' : testResult.ok ? 'ok' : 'err') : ''}`}>
          {resultText}
        </span>
        <button className="btn-secondary" onClick={() => setShowUsage(true)}>
          用量统计
        </button>
        <button className="btn-secondary" onClick={() => void onTest()} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        {(form.kind === 'openai' || form.kind === 'openai-compatible') && form.imageGeneration && (
          <button className="btn-secondary" onClick={() => void onTestImage()} disabled={imgTesting}>
            {imgTesting ? '生成中…' : '测试图像生成'}
          </button>
        )}
        {profileExists && (
          <button className="btn-secondary" onClick={() => void onSetActive()} disabled={isActive}>
            {isActive ? '当前' : '设为当前'}
          </button>
        )}
        {profileExists && (
          <button className="btn-secondary danger" onClick={() => void onDelete()}>
            删除
          </button>
        )}
        <button className="btn" onClick={() => void onSave()}>
          保存
        </button>
      </div>

      {imgTestResult && (
        <div className={`settings-imgtest ${imgTestResult.ok ? 'ok' : 'err'}`}>
          {imgTestResult.ok ? (
            <>
              <div className="settings-imgtest-msg">
                图像生成成功 · {imgTestResult.latencyMs ?? '?'}ms
                {imgTestResult.sawPartial ? ' · 收到流式预览' : ''}
              </div>
              {imgTestResult.dataUrl && (
                <img className="settings-imgtest-img" src={imgTestResult.dataUrl} alt="测试生成的图片" />
              )}
            </>
          ) : (
            <div className="settings-imgtest-msg">图像生成失败：{imgTestResult.error ?? '未知错误'}</div>
          )}
        </div>
      )}

      <UsageStatsModal open={showUsage} onClose={() => setShowUsage(false)} />
    </div>
  )
}
