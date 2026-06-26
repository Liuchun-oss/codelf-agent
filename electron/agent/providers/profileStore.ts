import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'fs'
import { join, dirname, basename } from 'path'
import { randomBytes } from 'crypto'
import type {
  ProviderProfile,
  ProviderProfileSummary,
  ProviderKind,
  ProfileDraft,
  AgentOpResult,
  SaveProfileResult
} from '@shared/agentTypes'
import { setSecret, getSecret, hasSecret, deleteSecret } from '../../ipc/secrets'



interface PersistShape {
  profiles: ProviderProfile[]
  activeProfileId: string | null
}

const VALID_KINDS: ReadonlySet<ProviderKind> = new Set<ProviderKind>([
  'openai',
  'azure-openai',
  'anthropic',
  'openai-compatible',
  'deepseek',
  'dify'
])

const DEFAULT_TIMEOUT_MS = 120_000

let cache: PersistShape | null = null

// 配置变更监听器（主进程注册，用于广播给渲染端刷新 UI）。
// 解耦：profileStore 不直接依赖 electron BrowserWindow。
const changeListeners = new Set<() => void>()

export function onProfilesChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function emitProfilesChanged(): void {
  for (const l of changeListeners) {
    try {
      l()
    } catch {
      // 监听器异常不影响存储
    }
  }
}

function profilesFile(): string {
  return join(app.getPath('userData'), 'profiles.json')
}


export function apiKeyRefFor(id: string): string {
  return `apiKey:${id}`
}

function load(): PersistShape {
  if (cache) return cache
  const file = profilesFile()
  if (!existsSync(file)) {
    cache = { profiles: [], activeProfileId: null }
    return cache
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<PersistShape>
    const profiles = Array.isArray(parsed?.profiles) ? (parsed.profiles as ProviderProfile[]) : []
    const activeProfileId =
      typeof parsed?.activeProfileId === 'string' ? parsed.activeProfileId : null
    
    const active = profiles.some((p) => p.id === activeProfileId) ? activeProfileId : null
    cache = { profiles, activeProfileId: active }
  } catch {
    console.error('[profileStore] profiles.json 解析失败，按空配置处理')
    cache = { profiles: [], activeProfileId: null }
  }
  return cache
}

function persist(state: PersistShape): void {
  const target = profilesFile()
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
    renameSync(tmp, target)
    emitProfilesChanged()
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      
    }
    throw e
  }
}

function toSummary(profile: ProviderProfile): ProviderProfileSummary {
  return { ...profile, hasApiKey: hasSecret(profile.apiKeyRef) }
}



export function listProfiles(): ProviderProfileSummary[] {
  return load().profiles.map(toSummary)
}

export function getProfileSummary(id: string): ProviderProfileSummary | null {
  const p = load().profiles.find((x) => x.id === id)
  return p ? toSummary(p) : null
}

export function getActiveProfileId(): string | null {
  return load().activeProfileId
}

export function getActiveProfileSummary(): ProviderProfileSummary | null {
  const { activeProfileId } = load()
  return activeProfileId ? getProfileSummary(activeProfileId) : null
}


export function getProfileRaw(id: string): ProviderProfile | null {
  return load().profiles.find((x) => x.id === id) ?? null
}


export function getActiveProfileApiKey(): string | null {
  const active = getProfileRaw(getActiveProfileId() ?? '')
  return active ? getSecret(active.apiKeyRef) : null
}

export function getProfileApiKey(profile: ProviderProfile | null): string | null {
  return profile ? getSecret(profile.apiKeyRef) : null
}

// 按 id 精确匹配，其次按名称/模型名不区分大小写匹配。
// 供子 Agent 指定模型时解析主 Agent 传入的标识符。
export function resolveProfileByIdOrName(ref: string | null | undefined): ProviderProfile | null {
  const key = ref?.trim()
  if (!key) return null
  const { profiles } = load()
  const byId = profiles.find((p) => p.id === key)
  if (byId) return byId
  const lower = key.toLowerCase()
  const byName = profiles.find((p) => p.name.toLowerCase() === lower)
  if (byName) return byName
  const byModel = profiles.find((p) => p.model.toLowerCase() === lower)
  if (byModel) return byModel
  return profiles.find((p) => p.name.toLowerCase().includes(lower) || p.model.toLowerCase().includes(lower)) ?? null
}



export function setActiveProfile(id: string | null): AgentOpResult {
  const state = load()
  if (id !== null && !state.profiles.some((p) => p.id === id)) {
    return { ok: false, error: '指定的 Provider 配置不存在' }
  }
  state.activeProfileId = id
  persist(state)
  return { ok: true }
}

export function saveProfile(draft: ProfileDraft): SaveProfileResult {
  if (!draft || typeof draft.id !== 'string' || draft.id.trim() === '') {
    return { ok: false, error: '缺少有效的配置 id' }
  }
  if (!VALID_KINDS.has(draft.kind)) {
    return { ok: false, error: `未知的 Provider 类型：${String(draft.kind)}` }
  }
  if (!draft.name?.trim()) return { ok: false, error: '配置名称不能为空' }
  if (!draft.baseUrl?.trim()) return { ok: false, error: 'Base URL 不能为空' }
  if (!draft.model?.trim()) return { ok: false, error: '模型名不能为空' }

  const state = load()
  const existing = state.profiles.find((p) => p.id === draft.id) ?? null
  const apiKeyRef = apiKeyRefFor(draft.id)

  
  
  const { apiKey, ...rest } = draft
  if (apiKey !== undefined) {
    try {
      if (apiKey === '') {
        deleteSecret(apiKeyRef)
      } else {
        setSecret(apiKeyRef, apiKey)
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '保存密钥失败' }
    }
  }

  const profile: ProviderProfile = {
    ...rest,
    apiKeyRef,
    
    lastTestAt: existing?.lastTestAt,
    lastTestOk: existing?.lastTestOk,
    lastTestLatencyMs: existing?.lastTestLatencyMs,
    timeoutMs:
      typeof draft.timeoutMs === 'number' && draft.timeoutMs > 0
        ? draft.timeoutMs
        : DEFAULT_TIMEOUT_MS
  }

  if (existing) {
    state.profiles = state.profiles.map((p) => (p.id === draft.id ? profile : p))
  } else {
    state.profiles.push(profile)
  }

  try {
    persist(state)
  } catch (e) {
    
    cache = null
    return { ok: false, error: e instanceof Error ? e.message : '保存配置失败' }
  }

  return { ok: true, profile: toSummary(profile) }
}


export function updateLastTest(id: string, result: { ok: boolean; latencyMs?: number }): void {
  const state = load()
  const p = state.profiles.find((x) => x.id === id)
  if (!p) return
  p.lastTestAt = new Date().toISOString()
  p.lastTestOk = result.ok
  p.lastTestLatencyMs = result.latencyMs
  persist(state)
}

export function deleteProfile(id: string): AgentOpResult {
  const state = load()
  const target = state.profiles.find((p) => p.id === id)
  if (!target) return { ok: false, error: '配置不存在' }

  state.profiles = state.profiles.filter((p) => p.id !== id)
  if (state.activeProfileId === id) state.activeProfileId = null

  try {
    persist(state)
  } catch (e) {
    cache = null
    return { ok: false, error: e instanceof Error ? e.message : '删除配置失败' }
  }

  
  deleteSecret(target.apiKeyRef)
  return { ok: true }
}
