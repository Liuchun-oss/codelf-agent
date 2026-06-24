
export type DeferredToolPolicySetting = 'explicit' | 'auto' | 'non-core'

export interface AgentBehaviorSettings {
  
  maxToolSteps: number
  
  maxTurnDurationMs: number
  
  acceptEditsAutoApplyDelayMs: number
  
  deferredToolPolicy: DeferredToolPolicySetting
  
  deferredToolAutoThresholdChars: number
  // 是否在每轮对话时自动检索知识库并把命中片段注入上下文。
  knowledgeInjectEnabled: boolean
  // 自动注入使用的知识库 id；空串表示用最近创建的知识库。
  knowledgeKbId: string
  // 每轮注入的最相关片段数量。
  knowledgeTopK: number
  // 相似度下限（0–1），低于此值的片段不注入/不返回。
  knowledgeMinScore: number
  // 安装插件时是否允许自动执行 npm install（会运行仓库的 postinstall 等脚本，
  // 属于供应链风险点）。默认关闭：关闭时跳过自动安装，仅提示用户手动安装依赖。
  pluginAllowNpmInstall: boolean
}


export interface NetworkSettings {
  
  proxyUrl: string
  
  useSystemProxy: boolean
  
  caCertPath: string
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  proxyUrl: '',
  useSystemProxy: true,
  caCertPath: ''
}


export function normalizeNetworkSettings(partial: Partial<NetworkSettings>): NetworkSettings {
  return {
    proxyUrl: typeof partial.proxyUrl === 'string' ? partial.proxyUrl.trim() : DEFAULT_NETWORK_SETTINGS.proxyUrl,
    useSystemProxy:
      typeof partial.useSystemProxy === 'boolean'
        ? partial.useSystemProxy
        : DEFAULT_NETWORK_SETTINGS.useSystemProxy,
    caCertPath: typeof partial.caCertPath === 'string' ? partial.caCertPath.trim() : DEFAULT_NETWORK_SETTINGS.caCertPath
  }
}




export type WebSearchProvider = 'auto' | 'aliyun-iqs' | 'brave' | 'duckduckgo'


export type IqsEngineType = 'Generic' | 'GenericAdvanced' | 'LiteAdvanced' | 'Deep'


export interface WebSearchSettings {
  
  provider: WebSearchProvider
  
  iqsEngineType: IqsEngineType
}

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  provider: 'auto',
  iqsEngineType: 'Generic'
}

const WEB_SEARCH_PROVIDERS: readonly WebSearchProvider[] = ['auto', 'aliyun-iqs', 'brave', 'duckduckgo']
const IQS_ENGINE_TYPES: readonly IqsEngineType[] = ['Generic', 'GenericAdvanced', 'LiteAdvanced', 'Deep']


export function normalizeWebSearchSettings(partial: Partial<WebSearchSettings>): WebSearchSettings {
  return {
    provider: WEB_SEARCH_PROVIDERS.includes(partial.provider as WebSearchProvider)
      ? (partial.provider as WebSearchProvider)
      : DEFAULT_WEB_SEARCH_SETTINGS.provider,
    iqsEngineType: IQS_ENGINE_TYPES.includes(partial.iqsEngineType as IqsEngineType)
      ? (partial.iqsEngineType as IqsEngineType)
      : DEFAULT_WEB_SEARCH_SETTINGS.iqsEngineType
  }
}


export interface WebSearchSettingsSummary extends WebSearchSettings {
  hasIqsKey: boolean
  hasBraveKey: boolean
  effectiveProvider: Exclude<WebSearchProvider, 'auto'>
}


export interface WebSearchSettingsDraft extends Partial<WebSearchSettings> {
  iqsApiKey?: string
  braveApiKey?: string
}

// ---- 图像生成（独立端点，走 OpenAI Images API: POST /v1/images/generations）----
// 与主对话 Provider 解耦：无论主模型是 DeepSeek/Anthropic 还是别的，
// 只要配了图像端点，GenerateImage 工具就能出图。
export interface ImageGenSettings {
  // 是否启用 GenerateImage 工具。
  enabled: boolean
  // 图像端点 base URL（如 https://api.openai.com/v1）。
  baseUrl: string
  // 图像模型名（如 gpt-image-1、dall-e-3，或第三方网关的模型名）。
  model: string
  // 默认图片尺寸（如 1024x1024、auto）。
  size: string
  // 请求超时（毫秒）。图像生成/编辑较慢，gpt-image 系列编辑常需 1~2 分钟。
  timeoutMs: number
  // 是否给生成图片加 AI 水印（火山方舟 Seedream 扩展字段；OpenAI 原生忽略此字段）。
  watermark: boolean
}

export const DEFAULT_IMAGE_GEN_SETTINGS: ImageGenSettings = {
  enabled: false,
  baseUrl: '',
  model: 'gpt-image-1',
  size: '1024x1024',
  timeoutMs: 180000,
  watermark: false
}

export function normalizeImageGenSettings(partial: Partial<ImageGenSettings>): ImageGenSettings {
  const rawTimeout = typeof partial.timeoutMs === 'number' ? partial.timeoutMs : DEFAULT_IMAGE_GEN_SETTINGS.timeoutMs
  return {
    enabled: typeof partial.enabled === 'boolean' ? partial.enabled : DEFAULT_IMAGE_GEN_SETTINGS.enabled,
    baseUrl: typeof partial.baseUrl === 'string' ? partial.baseUrl.trim() : DEFAULT_IMAGE_GEN_SETTINGS.baseUrl,
    model: typeof partial.model === 'string' && partial.model.trim() ? partial.model.trim() : DEFAULT_IMAGE_GEN_SETTINGS.model,
    size: typeof partial.size === 'string' && partial.size.trim() ? partial.size.trim() : DEFAULT_IMAGE_GEN_SETTINGS.size,
    timeoutMs: Number.isFinite(rawTimeout) && rawTimeout >= 10000 ? Math.min(rawTimeout, 600000) : DEFAULT_IMAGE_GEN_SETTINGS.timeoutMs,
    watermark: typeof partial.watermark === 'boolean' ? partial.watermark : DEFAULT_IMAGE_GEN_SETTINGS.watermark
  }
}

export interface ImageGenSettingsSummary extends ImageGenSettings {
  hasApiKey: boolean
}

export interface ImageGenSettingsDraft extends Partial<ImageGenSettings> {
  apiKey?: string
}

export interface ImageGenTestResult {
  ok: boolean
  error?: string
  latencyMs?: number
  // 生成图片的 data URL，供前端预览。
  dataUrl?: string
}

// ---- 视频生成（火山方舟异步任务：POST /contents/generations/tasks + 轮询）----
// 与图像生成独立配置：自己的 baseUrl/model/key/参数。
export interface VideoGenSettings {
  // 是否启用 GenerateVideo 工具。
  enabled: boolean
  // 视频端点 base URL（如 https://ark.cn-beijing.volces.com/api/v3）。
  baseUrl: string
  // 视频模型名 / 推理接入点 ID（如 doubao-seedance-1-5-pro-250528 或 ep-xxx）。
  model: string
  // 默认分辨率（480p / 720p / 1080p）。
  resolution: string
  // 默认时长（秒）。
  duration: number
  // 默认画面比例（如 16:9、9:16、1:1、4:3、21:9、auto）。
  ratio: string
  // 是否生成音频（部分模型支持，有声通常加价）。
  generateAudio: boolean
  // 是否加 AI 水印。
  watermark: boolean
  // 轮询总超时（毫秒）。视频生成较慢，默认 10 分钟。
  pollTimeoutMs: number
}

export const VIDEO_RESOLUTIONS: readonly string[] = ['480p', '720p', '1080p']
export const VIDEO_RATIOS: readonly string[] = ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9']

export const DEFAULT_VIDEO_GEN_SETTINGS: VideoGenSettings = {
  enabled: false,
  baseUrl: '',
  model: 'doubao-seedance-1-5-pro-251215',
  resolution: '720p',
  duration: 5,
  ratio: '16:9',
  generateAudio: false,
  watermark: false,
  pollTimeoutMs: 600000
}

export function normalizeVideoGenSettings(partial: Partial<VideoGenSettings>): VideoGenSettings {
  const d = DEFAULT_VIDEO_GEN_SETTINGS
  const rawTimeout = typeof partial.pollTimeoutMs === 'number' ? partial.pollTimeoutMs : d.pollTimeoutMs
  const rawDuration = typeof partial.duration === 'number' ? Math.floor(partial.duration) : d.duration
  return {
    enabled: typeof partial.enabled === 'boolean' ? partial.enabled : d.enabled,
    baseUrl: typeof partial.baseUrl === 'string' ? partial.baseUrl.trim() : d.baseUrl,
    model: typeof partial.model === 'string' && partial.model.trim() ? partial.model.trim() : d.model,
    resolution: typeof partial.resolution === 'string' && partial.resolution.trim() ? partial.resolution.trim() : d.resolution,
    duration: Number.isFinite(rawDuration) && rawDuration >= 1 ? Math.min(rawDuration, 30) : d.duration,
    ratio: typeof partial.ratio === 'string' && partial.ratio.trim() ? partial.ratio.trim() : d.ratio,
    generateAudio: typeof partial.generateAudio === 'boolean' ? partial.generateAudio : d.generateAudio,
    watermark: typeof partial.watermark === 'boolean' ? partial.watermark : d.watermark,
    pollTimeoutMs: Number.isFinite(rawTimeout) && rawTimeout >= 30000 ? Math.min(rawTimeout, 1800000) : d.pollTimeoutMs
  }
}

export interface VideoGenSettingsSummary extends VideoGenSettings {
  hasApiKey: boolean
}

export interface VideoGenSettingsDraft extends Partial<VideoGenSettings> {
  apiKey?: string
}

export interface VideoGenTestResult {
  ok: boolean
  error?: string
  latencyMs?: number
  videoUrl?: string
}

// ---- 音频生成 / 文生音（多供应商适配：火山豆包 / OpenAI 兼容 / MiniMax）----
// 与图像/视频生成独立配置。第一期仅支持预设音色 TTS（文本→语音），
// 音色克隆（参考音频→speaker_id）留待后续迭代。
// 不同供应商的请求/响应结构差异很大（火山走 JSON 内嵌 base64，OpenAI 走二进制流），
// 故按 provider 选择不同适配器，而非单纯换 baseUrl。
export type AudioProvider = 'volcano' | 'openai' | 'minimax'

export interface AudioGenSettings {
  // 是否启用 GenerateSpeech 工具。
  enabled: boolean
  // 供应商，决定请求/响应适配器。
  provider: AudioProvider
  // 语音端点 base URL。
  baseUrl: string
  // 模型名（OpenAI: tts-1 / gpt-4o-mini-tts；MiniMax: speech-01 等。火山不使用）。
  model: string
  // 火山应用 App ID（仅 volcano）。
  appid: string
  // 火山业务集群（仅 volcano，如 volcano_tts）。
  cluster: string
  // MiniMax group_id（仅 minimax）。
  groupId: string
  // 默认音色（火山 voice_type / OpenAI voice / MiniMax voice_id）。
  voiceType: string
  // 默认输出音频格式（mp3 / wav / pcm / ogg_opus）。
  encoding: string
  // 默认语速，范围 0.5~2.0。
  speed: number
  // 请求超时（毫秒）。TTS 通常秒级，给足冗余。
  timeoutMs: number
}

// 供应商元信息：默认 baseUrl 与展示名。
export const AUDIO_PROVIDERS: readonly { id: AudioProvider; label: string; defaultBaseUrl: string }[] = [
  { id: 'volcano', label: '火山豆包语音', defaultBaseUrl: 'https://openspeech.bytedance.com' },
  { id: 'openai', label: 'OpenAI 兼容（/v1/audio/speech）', defaultBaseUrl: 'https://api.openai.com/v1' },
  { id: 'minimax', label: 'MiniMax（海螺 T2A）', defaultBaseUrl: 'https://api.minimax.chat/v1' }
]

// 常用预设音色（火山大模型音色，实际可用列表以账号开通为准）。
// OpenAI/MiniMax 的音色名不同，可在「自定义音色 ID」里直接填写。
export const AUDIO_VOICES: readonly { id: string; label: string }[] = [
  { id: 'zh_female_qingxin', label: '清新女声' },
  { id: 'zh_female_shuangkuai', label: '爽快女声' },
  { id: 'zh_male_baqigangbu', label: '霸气男声' },
  { id: 'zh_male_qingse', label: '青涩男声' },
  { id: 'zh_female_wennuan', label: '温暖女声' },
  { id: 'zh_male_chunhou', label: '醇厚男声' }
]

export const AUDIO_ENCODINGS: readonly string[] = ['mp3', 'wav', 'ogg_opus', 'pcm']

export const DEFAULT_AUDIO_GEN_SETTINGS: AudioGenSettings = {
  enabled: false,
  provider: 'volcano',
  baseUrl: 'https://openspeech.bytedance.com',
  model: '',
  appid: '',
  cluster: 'volcano_tts',
  groupId: '',
  voiceType: 'zh_female_qingxin',
  encoding: 'mp3',
  speed: 1.0,
  timeoutMs: 60000
}

export function normalizeAudioGenSettings(partial: Partial<AudioGenSettings>): AudioGenSettings {
  const d = DEFAULT_AUDIO_GEN_SETTINGS
  const rawTimeout = typeof partial.timeoutMs === 'number' ? partial.timeoutMs : d.timeoutMs
  const rawSpeed = typeof partial.speed === 'number' && Number.isFinite(partial.speed) ? partial.speed : d.speed
  const provider: AudioProvider =
    partial.provider === 'openai' || partial.provider === 'minimax' || partial.provider === 'volcano'
      ? partial.provider
      : d.provider
  return {
    enabled: typeof partial.enabled === 'boolean' ? partial.enabled : d.enabled,
    provider,
    baseUrl: typeof partial.baseUrl === 'string' && partial.baseUrl.trim() ? partial.baseUrl.trim() : d.baseUrl,
    model: typeof partial.model === 'string' ? partial.model.trim() : d.model,
    appid: typeof partial.appid === 'string' ? partial.appid.trim() : d.appid,
    cluster: typeof partial.cluster === 'string' && partial.cluster.trim() ? partial.cluster.trim() : d.cluster,
    groupId: typeof partial.groupId === 'string' ? partial.groupId.trim() : d.groupId,
    voiceType: typeof partial.voiceType === 'string' && partial.voiceType.trim() ? partial.voiceType.trim() : d.voiceType,
    encoding: typeof partial.encoding === 'string' && partial.encoding.trim() ? partial.encoding.trim() : d.encoding,
    speed: Math.min(2, Math.max(0.5, Math.round(rawSpeed * 10) / 10)),
    timeoutMs: Number.isFinite(rawTimeout) && rawTimeout >= 5000 ? Math.min(rawTimeout, 300000) : d.timeoutMs
  }
}

export interface AudioGenSettingsSummary extends AudioGenSettings {
  hasApiKey: boolean
}

export interface AudioGenSettingsDraft extends Partial<AudioGenSettings> {
  apiKey?: string
}

export interface AudioGenTestResult {
  ok: boolean
  error?: string
  latencyMs?: number
  // 生成音频的 data URL，供前端试听。
  dataUrl?: string
}

export type VideoTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

// 后台视频生成任务（持久化到磁盘，跨重启可见）。
export interface VideoTask {
  id: string
  // 火山返回的任务 ID（cgt-xxx）；提交成功后填入。
  remoteTaskId?: string
  status: VideoTaskStatus
  prompt: string
  // 提交时的参数快照（用于展示）。
  resolution: string
  ratio: string
  duration: number
  generateAudio: boolean
  // 最新进度文本（如「生成中…已用时 45s」）。
  progress?: string
  error?: string
  // 成功后的本地视频 artifact URL。
  videoUrl?: string
  // 成功后落盘的本地绝对文件路径（供 agent 后续处理，如拼接多镜头）。
  filePath?: string
  // agent 请求的输出位置（目录或文件路径）。展示/调试用。
  outputPath?: string
  createdAt: number
  updatedAt: number
}

export const DEFAULT_AGENT_BEHAVIOR: AgentBehaviorSettings = {
  maxToolSteps: 0,
  maxTurnDurationMs: 20 * 60 * 1000,
  acceptEditsAutoApplyDelayMs: 3000,
  deferredToolPolicy: 'explicit',
  deferredToolAutoThresholdChars: 18_000,
  knowledgeInjectEnabled: false,
  knowledgeKbId: '',
  knowledgeTopK: 5,
  knowledgeMinScore: 0.35,
  pluginAllowNpmInstall: false
}

export const AGENT_BEHAVIOR_BOUNDS = {
  maxToolSteps: { min: 0, max: 200 },
  maxTurnDurationMs: { min: 60_000, max: 120 * 60 * 1000 },
  acceptEditsAutoApplyDelayMs: { min: 0, max: 60_000 },
  deferredToolAutoThresholdChars: { min: 1_000, max: 200_000 },
  knowledgeTopK: { min: 1, max: 20 },
  knowledgeMinScore: { min: 0, max: 1 }
} as const


export function normalizeAgentBehavior(
  partial: Partial<AgentBehaviorSettings>
): AgentBehaviorSettings {
  const b = AGENT_BEHAVIOR_BOUNDS
  const n = (v: unknown, min: number, max: number, fallback: number): number => {
    const x = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback
    return Math.min(max, Math.max(min, x))
  }
  const policy = partial.deferredToolPolicy
  return {
    maxToolSteps: n(
      partial.maxToolSteps,
      b.maxToolSteps.min,
      b.maxToolSteps.max,
      DEFAULT_AGENT_BEHAVIOR.maxToolSteps
    ),
    maxTurnDurationMs: n(
      partial.maxTurnDurationMs,
      b.maxTurnDurationMs.min,
      b.maxTurnDurationMs.max,
      DEFAULT_AGENT_BEHAVIOR.maxTurnDurationMs
    ),
    acceptEditsAutoApplyDelayMs: n(
      partial.acceptEditsAutoApplyDelayMs,
      b.acceptEditsAutoApplyDelayMs.min,
      b.acceptEditsAutoApplyDelayMs.max,
      DEFAULT_AGENT_BEHAVIOR.acceptEditsAutoApplyDelayMs
    ),
    deferredToolPolicy:
      policy === 'explicit' || policy === 'auto' || policy === 'non-core'
        ? policy
        : DEFAULT_AGENT_BEHAVIOR.deferredToolPolicy,
    deferredToolAutoThresholdChars: n(
      partial.deferredToolAutoThresholdChars,
      b.deferredToolAutoThresholdChars.min,
      b.deferredToolAutoThresholdChars.max,
      DEFAULT_AGENT_BEHAVIOR.deferredToolAutoThresholdChars
    ),
    knowledgeInjectEnabled:
      typeof partial.knowledgeInjectEnabled === 'boolean'
        ? partial.knowledgeInjectEnabled
        : DEFAULT_AGENT_BEHAVIOR.knowledgeInjectEnabled,
    knowledgeKbId:
      typeof partial.knowledgeKbId === 'string'
        ? partial.knowledgeKbId.trim()
        : DEFAULT_AGENT_BEHAVIOR.knowledgeKbId,
    knowledgeTopK: n(
      partial.knowledgeTopK,
      b.knowledgeTopK.min,
      b.knowledgeTopK.max,
      DEFAULT_AGENT_BEHAVIOR.knowledgeTopK
    ),
    knowledgeMinScore: (() => {
      const x =
        typeof partial.knowledgeMinScore === 'number' && Number.isFinite(partial.knowledgeMinScore)
          ? partial.knowledgeMinScore
          : DEFAULT_AGENT_BEHAVIOR.knowledgeMinScore
      return Math.min(b.knowledgeMinScore.max, Math.max(b.knowledgeMinScore.min, Math.round(x * 100) / 100))
    })(),
    pluginAllowNpmInstall:
      typeof partial.pluginAllowNpmInstall === 'boolean'
        ? partial.pluginAllowNpmInstall
        : DEFAULT_AGENT_BEHAVIOR.pluginAllowNpmInstall
  }
}
