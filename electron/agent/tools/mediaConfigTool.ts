import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import {
  getImageGenSettings,
  saveImageGenSettings,
  getVideoGenSettings,
  saveVideoGenSettings,
  getAudioGenSettings,
  saveAudioGenSettings
} from '../settings/agentSettingsStore'
import { IMAGE_GEN_KEY_REF } from '../services/imageGenService'
import { VIDEO_GEN_KEY_REF } from '../services/videoGenService'
import { AUDIO_GEN_KEY_REF } from '../services/audioGenService'
import { setSecret, deleteSecret, hasSecret } from '../../ipc/secrets'

export const MEDIA_CONFIG_TOOL_NAME = 'MediaConfig'

const audioProviderSchema = z.enum(['volcano', 'openai', 'minimax'])

const mediaConfigSchema = z.object({
  target: z
    .enum(['image', 'video', 'audio'])
    .describe('要操作的配置类别：image 图像生成 / video 视频生成 / audio 文生音(TTS)'),
  action: z
    .enum(['get', 'set'])
    .describe('get 读取当前配置；set 修改配置（只更新传入的字段，其余保持不变）'),
  // 通用字段（三类共有）。
  enabled: z.boolean().optional().describe('是否启用对应的生成工具'),
  baseUrl: z.string().optional().describe('端点 Base URL'),
  model: z.string().optional().describe('模型名 / 接入点 ID（audio 的 volcano 供应商不需要）'),
  timeoutMs: z.number().int().positive().optional().describe('请求超时毫秒（video 为轮询超时 pollTimeoutMs）'),
  apiKey: z.string().optional().describe('对应端点的 API Key / Token；写入系统安全存储。传空字符串可清除'),
  // image 专属。
  size: z.string().optional().describe('[image] 默认图片尺寸，如 2K / 1024x1024'),
  // image / video 共有。
  watermark: z.boolean().optional().describe('[image/video] 是否加 AI 水印'),
  // video 专属。
  resolution: z.string().optional().describe('[video] 默认分辨率，如 480p/720p/1080p'),
  duration: z.number().int().positive().optional().describe('[video] 默认时长（秒）'),
  ratio: z.string().optional().describe('[video] 默认画面比例，如 16:9'),
  generateAudio: z.boolean().optional().describe('[video] 是否生成有声视频'),
  // audio 专属。
  provider: audioProviderSchema.optional().describe('[audio] 供应商：volcano/openai/minimax'),
  appid: z.string().optional().describe('[audio] 火山 App ID（仅 volcano）'),
  cluster: z.string().optional().describe('[audio] 火山业务集群，如 volcano_tts（仅 volcano）'),
  groupId: z.string().optional().describe('[audio] MiniMax group_id（仅 minimax）'),
  voiceType: z.string().optional().describe('[audio] 音色 ID（火山 voice_type / OpenAI voice / MiniMax voice_id）'),
  encoding: z.string().optional().describe('[audio] 输出格式：mp3/wav/ogg_opus/pcm'),
  speed: z.number().optional().describe('[audio] 语速 0.5~2.0')
})

type MediaConfigInput = z.infer<typeof mediaConfigSchema>

const KEY_REF: Record<MediaConfigInput['target'], string> = {
  image: IMAGE_GEN_KEY_REF,
  video: VIDEO_GEN_KEY_REF,
  audio: AUDIO_GEN_KEY_REF
}

function describeImage(): string {
  const s = getImageGenSettings()
  return [
    '图像生成配置：',
    `- 启用：${s.enabled ? '是' : '否'}`,
    `- Base URL：${s.baseUrl || '(未配置)'}`,
    `- 模型名：${s.model}`,
    `- 默认尺寸：${s.size}`,
    `- 超时：${Math.round(s.timeoutMs / 1000)}s`,
    `- 水印：${s.watermark ? '是' : '否'}`,
    `- API Key：${hasSecret(IMAGE_GEN_KEY_REF) ? '已配置' : '未配置'}`
  ].join('\n')
}

function describeVideo(): string {
  const s = getVideoGenSettings()
  return [
    '视频生成配置：',
    `- 启用：${s.enabled ? '是' : '否'}`,
    `- Base URL：${s.baseUrl || '(未配置)'}`,
    `- 模型名 / 接入点：${s.model}`,
    `- 默认分辨率：${s.resolution}`,
    `- 默认时长：${s.duration}s`,
    `- 默认比例：${s.ratio}`,
    `- 生成音频：${s.generateAudio ? '是' : '否'}`,
    `- 水印：${s.watermark ? '是' : '否'}`,
    `- 轮询超时：${Math.round(s.pollTimeoutMs / 1000)}s`,
    `- API Key：${hasSecret(VIDEO_GEN_KEY_REF) ? '已配置' : '未配置'}`
  ].join('\n')
}

function describeAudio(): string {
  const s = getAudioGenSettings()
  const lines = [
    '文生音配置：',
    `- 启用：${s.enabled ? '是' : '否'}`,
    `- 供应商：${s.provider}`,
    `- Base URL：${s.baseUrl || '(未配置)'}`,
    `- 模型名：${s.model || '(空)'}`,
    `- 音色：${s.voiceType}`,
    `- 输出格式：${s.encoding}`,
    `- 语速：${s.speed}`,
    `- 超时：${Math.round(s.timeoutMs / 1000)}s`,
    `- API Key：${hasSecret(AUDIO_GEN_KEY_REF) ? '已配置' : '未配置'}`
  ]
  if (s.provider === 'volcano') lines.push(`- 火山 App ID：${s.appid || '(未配置)'}`, `- 火山 Cluster：${s.cluster}`)
  if (s.provider === 'minimax') lines.push(`- MiniMax group_id：${s.groupId || '(未配置)'}`)
  return lines.join('\n')
}

function describe(target: MediaConfigInput['target']): string {
  if (target === 'image') return describeImage()
  if (target === 'video') return describeVideo()
  return describeAudio()
}

function applyImage(input: MediaConfigInput): boolean {
  const patch: Parameters<typeof saveImageGenSettings>[0] = {}
  if (input.enabled !== undefined) patch.enabled = input.enabled
  if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl
  if (input.model !== undefined) patch.model = input.model
  if (input.size !== undefined) patch.size = input.size
  if (input.timeoutMs !== undefined) patch.timeoutMs = input.timeoutMs
  if (input.watermark !== undefined) patch.watermark = input.watermark
  if (Object.keys(patch).length === 0) return false
  saveImageGenSettings(patch)
  return true
}

function applyVideo(input: MediaConfigInput): boolean {
  const patch: Parameters<typeof saveVideoGenSettings>[0] = {}
  if (input.enabled !== undefined) patch.enabled = input.enabled
  if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl
  if (input.model !== undefined) patch.model = input.model
  if (input.resolution !== undefined) patch.resolution = input.resolution
  if (input.duration !== undefined) patch.duration = input.duration
  if (input.ratio !== undefined) patch.ratio = input.ratio
  if (input.generateAudio !== undefined) patch.generateAudio = input.generateAudio
  if (input.watermark !== undefined) patch.watermark = input.watermark
  // video 的超时字段是 pollTimeoutMs。
  if (input.timeoutMs !== undefined) patch.pollTimeoutMs = input.timeoutMs
  if (Object.keys(patch).length === 0) return false
  saveVideoGenSettings(patch)
  return true
}

function applyAudio(input: MediaConfigInput): boolean {
  const patch: Parameters<typeof saveAudioGenSettings>[0] = {}
  if (input.enabled !== undefined) patch.enabled = input.enabled
  if (input.provider !== undefined) patch.provider = input.provider
  if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl
  if (input.model !== undefined) patch.model = input.model
  if (input.appid !== undefined) patch.appid = input.appid
  if (input.cluster !== undefined) patch.cluster = input.cluster
  if (input.groupId !== undefined) patch.groupId = input.groupId
  if (input.voiceType !== undefined) patch.voiceType = input.voiceType
  if (input.encoding !== undefined) patch.encoding = input.encoding
  if (input.speed !== undefined) patch.speed = input.speed
  if (input.timeoutMs !== undefined) patch.timeoutMs = input.timeoutMs
  if (Object.keys(patch).length === 0) return false
  saveAudioGenSettings(patch)
  return true
}

export const mediaConfigTool: Tool<MediaConfigInput> = {
  name: MEDIA_CONFIG_TOOL_NAME,
  description:
    '读写应用的媒体生成配置：图像生成（image）、视频生成（video）、文生音 TTS（audio）。' +
    '用 target 指定类别，action=get 读取当前配置、action=set 修改（只更新传入字段，其余不变）。' +
    'set 时可一并写入该端点的 apiKey（存入系统安全存储，不会明文回显）。' +
    '各 target 的专属字段见参数说明（如 image 的 size、video 的 resolution/duration/ratio、audio 的 provider/appid/cluster/groupId/voiceType）。' +
    '配置改动即时生效，无需用户在设置面板手动操作。',
  schema: mediaConfigSchema,
  // 标记为 readOnly 以跳过写入审批（与 ModelConfig 一致：配置改动无需逐次确认）。
  readOnly: true,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    if (input.action === 'get') {
      return { content: `当前${describe(input.target)}` }
    }

    // set：先处理密钥（与配置分离存储），再写其余字段。
    const changedKey = input.apiKey !== undefined
    if (changedKey) {
      try {
        if (input.apiKey === '') deleteSecret(KEY_REF[input.target])
        else setSecret(KEY_REF[input.target], input.apiKey as string)
      } catch (e) {
        return { content: e instanceof Error ? e.message : '写入密钥失败', isError: true }
      }
    }

    const changedFields =
      input.target === 'image' ? applyImage(input) : input.target === 'video' ? applyVideo(input) : applyAudio(input)

    if (!changedFields && !changedKey) {
      return { content: '未提供任何要修改的字段。', isError: true }
    }
    return { content: `已更新${describe(input.target)}` }
  }
}
