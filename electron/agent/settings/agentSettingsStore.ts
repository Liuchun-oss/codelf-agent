import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'fs'
import { join, dirname, basename } from 'path'
import { randomBytes } from 'crypto'
import type { AgentBehaviorSettings, NetworkSettings, WebSearchSettings, ImageGenSettings, VideoGenSettings, AudioGenSettings } from '@shared/agentSettings'
import {
  DEFAULT_AGENT_BEHAVIOR,
  DEFAULT_NETWORK_SETTINGS,
  DEFAULT_WEB_SEARCH_SETTINGS,
  DEFAULT_IMAGE_GEN_SETTINGS,
  DEFAULT_VIDEO_GEN_SETTINGS,
  DEFAULT_AUDIO_GEN_SETTINGS,
  normalizeAgentBehavior,
  normalizeNetworkSettings,
  normalizeWebSearchSettings,
  normalizeImageGenSettings,
  normalizeVideoGenSettings,
  normalizeAudioGenSettings
} from '@shared/agentSettings'
import type { McpSettings } from '@shared/mcpTypes'
import { DEFAULT_MCP_SETTINGS, normalizeMcpSettings } from '@shared/mcpTypes'
import type { SkillsSettings } from '@shared/skillTypes'
import { DEFAULT_SKILLS_SETTINGS, normalizeSkillsSettings } from '@shared/skillTypes'
import type { MemorySettings } from '@shared/memoryTypes'
import { DEFAULT_MEMORY_SETTINGS, normalizeMemorySettings } from '@shared/memoryTypes'
import type { ChannelsSettings } from '@shared/channelTypes'
import { DEFAULT_CHANNELS_SETTINGS, normalizeChannelsSettings } from '@shared/channelTypes'


interface SettingsFileShape {
  agent?: Partial<AgentBehaviorSettings>
  network?: Partial<NetworkSettings>
  webSearch?: Partial<WebSearchSettings>
  imageGen?: Partial<ImageGenSettings>
  videoGen?: Partial<VideoGenSettings>
  audioGen?: Partial<AudioGenSettings>
  mcp?: unknown
  skills?: unknown
  memory?: Partial<MemorySettings>
  channels?: Partial<ChannelsSettings>
  // UI 端"自动审批"开关的镜像（渲染端 localStorage 是权威源，这里供主进程/微信通道读取）。
  permissionMode?: 'default' | 'acceptEdits'
}

let cache: AgentBehaviorSettings | null = null
let networkCache: NetworkSettings | null = null
let webSearchCache: WebSearchSettings | null = null
let imageGenCache: ImageGenSettings | null = null
let videoGenCache: VideoGenSettings | null = null
let audioGenCache: AudioGenSettings | null = null
let mcpCache: McpSettings | null = null
let skillsCache: SkillsSettings | null = null
let memoryCache: MemorySettings | null = null
let channelsCache: ChannelsSettings | null = null

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function readFile(): SettingsFileShape {
  const file = settingsFile()
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as SettingsFileShape
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    console.error('[agentSettingsStore] settings.json 解析失败，使用默认值')
    return {}
  }
}

function writeFile(shape: SettingsFileShape): void {
  const target = settingsFile()
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(shape, null, 2), 'utf-8')
    renameSync(tmp, target)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      
    }
    throw e
  }
}

function loadFromDisk(): AgentBehaviorSettings {
  const raw = readFile().agent ?? {}
  return normalizeAgentBehavior({ ...DEFAULT_AGENT_BEHAVIOR, ...raw })
}


export function getAgentBehaviorSettings(): AgentBehaviorSettings {
  if (!cache) cache = loadFromDisk()
  return cache
}


export function saveAgentBehaviorSettings(
  patch: Partial<AgentBehaviorSettings>
): AgentBehaviorSettings {
  const file = readFile()
  const next = normalizeAgentBehavior({
    ...getAgentBehaviorSettings(),
    ...patch
  })
  writeFile({ ...file, agent: next })
  cache = next
  return next
}


export function resetAgentSettingsCacheForTests(): void {
  cache = null
  networkCache = null
  webSearchCache = null
  imageGenCache = null
  videoGenCache = null
  audioGenCache = null
  mcpCache = null
  skillsCache = null
  memoryCache = null
  channelsCache = null
}



function loadNetworkFromDisk(): NetworkSettings {
  const raw = readFile().network ?? {}
  return normalizeNetworkSettings({ ...DEFAULT_NETWORK_SETTINGS, ...raw })
}


export function getNetworkSettings(): NetworkSettings {
  if (!networkCache) networkCache = loadNetworkFromDisk()
  return networkCache
}


export function saveNetworkSettings(patch: Partial<NetworkSettings>): NetworkSettings {
  const file = readFile()
  const next = normalizeNetworkSettings({ ...getNetworkSettings(), ...patch })
  writeFile({ ...file, network: next })
  networkCache = next
  return next
}



function loadWebSearchFromDisk(): WebSearchSettings {
  const raw = readFile().webSearch ?? {}
  return normalizeWebSearchSettings({ ...DEFAULT_WEB_SEARCH_SETTINGS, ...raw })
}


export function getWebSearchSettings(): WebSearchSettings {
  if (!webSearchCache) webSearchCache = loadWebSearchFromDisk()
  return webSearchCache
}


export function saveWebSearchSettings(patch: Partial<WebSearchSettings>): WebSearchSettings {
  const file = readFile()
  const next = normalizeWebSearchSettings({ ...getWebSearchSettings(), ...patch })
  writeFile({ ...file, webSearch: next })
  webSearchCache = next
  return next
}


function loadImageGenFromDisk(): ImageGenSettings {
  const raw = readFile().imageGen ?? {}
  return normalizeImageGenSettings({ ...DEFAULT_IMAGE_GEN_SETTINGS, ...raw })
}

export function getImageGenSettings(): ImageGenSettings {
  if (!imageGenCache) imageGenCache = loadImageGenFromDisk()
  return imageGenCache
}

export function saveImageGenSettings(patch: Partial<ImageGenSettings>): ImageGenSettings {
  const file = readFile()
  const next = normalizeImageGenSettings({ ...getImageGenSettings(), ...patch })
  writeFile({ ...file, imageGen: next })
  imageGenCache = next
  return next
}

function loadVideoGenFromDisk(): VideoGenSettings {
  const raw = readFile().videoGen ?? {}
  return normalizeVideoGenSettings({ ...DEFAULT_VIDEO_GEN_SETTINGS, ...raw })
}

export function getVideoGenSettings(): VideoGenSettings {
  if (!videoGenCache) videoGenCache = loadVideoGenFromDisk()
  return videoGenCache
}

export function saveVideoGenSettings(patch: Partial<VideoGenSettings>): VideoGenSettings {
  const file = readFile()
  const next = normalizeVideoGenSettings({ ...getVideoGenSettings(), ...patch })
  writeFile({ ...file, videoGen: next })
  videoGenCache = next
  return next
}

function loadAudioGenFromDisk(): AudioGenSettings {
  const raw = readFile().audioGen ?? {}
  return normalizeAudioGenSettings({ ...DEFAULT_AUDIO_GEN_SETTINGS, ...raw })
}

export function getAudioGenSettings(): AudioGenSettings {
  if (!audioGenCache) audioGenCache = loadAudioGenFromDisk()
  return audioGenCache
}

export function saveAudioGenSettings(patch: Partial<AudioGenSettings>): AudioGenSettings {
  const file = readFile()
  const next = normalizeAudioGenSettings({ ...getAudioGenSettings(), ...patch })
  writeFile({ ...file, audioGen: next })
  audioGenCache = next
  return next
}



function loadMcpFromDisk(): McpSettings {
  return normalizeMcpSettings(readFile().mcp ?? DEFAULT_MCP_SETTINGS)
}


export function getMcpSettings(): McpSettings {
  if (!mcpCache) mcpCache = loadMcpFromDisk()
  return mcpCache
}


// 覆盖式写入整份 MCP 配置（server 增删改都走这里）。
export function saveMcpSettings(next: McpSettings): McpSettings {
  const file = readFile()
  const normalized = normalizeMcpSettings(next)
  writeFile({ ...file, mcp: normalized })
  mcpCache = normalized
  return normalized
}

// 记录某工作区内项目级 server 的审批决定（approved/rejected）。
export function setMcpProjectApproval(
  workspaceRoot: string,
  serverName: string,
  state: 'approved' | 'rejected'
): McpSettings {
  const current = getMcpSettings()
  const approvals = { ...(current.projectApprovals ?? {}) }
  const perRoot = { ...(approvals[workspaceRoot] ?? {}) }
  perRoot[serverName] = state
  approvals[workspaceRoot] = perRoot
  return saveMcpSettings({ ...current, projectApprovals: approvals })
}


function loadSkillsFromDisk(): SkillsSettings {
  return normalizeSkillsSettings(readFile().skills ?? DEFAULT_SKILLS_SETTINGS)
}

export function getSkillsSettings(): SkillsSettings {
  if (!skillsCache) skillsCache = loadSkillsFromDisk()
  return skillsCache
}

export function saveSkillsSettings(next: SkillsSettings): SkillsSettings {
  const file = readFile()
  const normalized = normalizeSkillsSettings(next)
  writeFile({ ...file, skills: normalized })
  skillsCache = normalized
  return normalized
}

// 设置某个 skill 的启用/禁用状态（按名称小写匹配，跨来源生效）。
export function setSkillDisabled(name: string, disabled: boolean): SkillsSettings {
  const key = name.trim().toLowerCase()
  if (!key) return getSkillsSettings()
  const current = getSkillsSettings()
  const set = new Set(current.disabled)
  if (disabled) set.add(key)
  else set.delete(key)
  return saveSkillsSettings({ disabled: [...set] })
}


function loadMemoryFromDisk(): MemorySettings {
  return normalizeMemorySettings(readFile().memory ?? DEFAULT_MEMORY_SETTINGS)
}

export function getMemorySettings(): MemorySettings {
  if (!memoryCache) memoryCache = loadMemoryFromDisk()
  return memoryCache
}

export function saveMemorySettings(patch: Partial<MemorySettings>): MemorySettings {
  const file = readFile()
  const next = normalizeMemorySettings({ ...getMemorySettings(), ...patch })
  writeFile({ ...file, memory: next })
  memoryCache = next
  return next
}


function loadChannelsFromDisk(): ChannelsSettings {
  const next = normalizeChannelsSettings(readFile().channels ?? DEFAULT_CHANNELS_SETTINGS)
  // 专属工作区未配置时，补一个默认路径（用户数据目录下的 weixin-workspace）。
  if (!next.weixin.workspaceRoot) {
    next.weixin.workspaceRoot = join(app.getPath('userData'), 'weixin-workspace')
  }
  return next
}

export function getChannelsSettings(): ChannelsSettings {
  if (!channelsCache) channelsCache = loadChannelsFromDisk()
  return channelsCache
}

// 覆盖式写入整份 channels 配置（深合并由调用方负责，这里按分区替换）。
export function saveChannelsSettings(patch: Partial<ChannelsSettings>): ChannelsSettings {
  const file = readFile()
  const current = getChannelsSettings()
  const next = normalizeChannelsSettings({
    weixin: { ...current.weixin, ...(patch.weixin ?? {}) }
  })
  writeFile({ ...file, channels: next })
  channelsCache = next
  return next
}

// "自动审批"权限模式（UI localStorage 的镜像）。微信通道无 UI，靠它判断是否自动放行。
// 默认 default（更安全：未显式开启则逐次确认）。
export function getPermissionMode(): 'default' | 'acceptEdits' {
  const v = readFile().permissionMode
  return v === 'acceptEdits' ? 'acceptEdits' : 'default'
}

export function setPermissionMode(mode: 'default' | 'acceptEdits'): void {
  const file = readFile()
  writeFile({ ...file, permissionMode: mode === 'acceptEdits' ? 'acceptEdits' : 'default' })
}
