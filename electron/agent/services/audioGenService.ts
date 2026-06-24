import { randomUUID } from 'crypto'
import { getAudioGenSettings } from '../settings/agentSettingsStore'
import { getSecret } from '../../ipc/secrets'
import { guardOutboundUrl } from '../tools/ssrfGuard'
import { getFetchOptions } from '../providers/network'
import { saveGeneratedAudio, type SavedGeneratedAudio } from '../../services/generatedAudioStore'
import { userAgent } from '@shared/appConfig'
import type { AudioGenSettings } from '@shared/agentSettings'

// 文生音端点的访问令牌（Access Token / API Key）在 secrets 存储里的引用名。
export const AUDIO_GEN_KEY_REF = 'audiogen:apiKey'

export interface AudioGenRequest {
  text: string
  // 音色（火山 voice_type / OpenAI voice / MiniMax voice_id）。缺省取设置默认。
  voice?: string
  // 语速 0.5~2.0。缺省取设置默认。
  speed?: number
  // 输出格式 mp3 / wav / ogg_opus / pcm。缺省取设置默认。
  encoding?: string
}

export interface AudioGenOutcome {
  ok: boolean
  error?: string
  audio?: SavedGeneratedAudio
  // 测试预览：音频 data URL（不落盘场景）。
  firstDataUrl?: string
}

// 适配器返回的原始音频：buffer + 用于 data URL 的 mime + 落盘扩展名。
interface RawAudio {
  buffer: Buffer
  mime: string
  // 实际音频格式对应的文件扩展名（mp3/wav/ogg/pcm/flac），用于正确落盘。
  ext: string
}

function describeFetchError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const cause = (e as { cause?: unknown })?.cause
  if (cause) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause)
    const code = (cause as { code?: unknown })?.code
    const codeStr = typeof code === 'string' ? `${code}: ` : ''
    if (causeMsg && causeMsg !== msg) return `请求语音端点失败：${msg}（${codeStr}${causeMsg}）`
  }
  return `请求语音端点失败：${msg}`
}

function mimeForEncoding(encoding: string): string {
  const e = encoding.toLowerCase()
  if (e.includes('wav')) return 'audio/wav'
  if (e.includes('ogg') || e.includes('opus')) return 'audio/ogg'
  if (e.includes('pcm')) return 'audio/L16'
  if (e.includes('flac')) return 'audio/flac'
  return 'audio/mpeg'
}

// 音频格式对应的落盘扩展名。
function extForFormat(fmt: string): string {
  const f = fmt.toLowerCase()
  if (f.includes('wav')) return 'wav'
  if (f.includes('ogg') || f.includes('opus')) return 'ogg'
  if (f.includes('pcm')) return 'pcm'
  if (f.includes('flac')) return 'flac'
  return 'mp3'
}

// 把外部 signal 和超时合并成一个 signal（超时后中断请求）。
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController()
  const onAbort = (): void => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => ctrl.abort(new Error(`语音请求超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs)
  return {
    signal: ctrl.signal,
    clear: () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }
}

interface AdapterContext {
  settings: AudioGenSettings
  token: string
  voice: string
  encoding: string
  speed: number
  text: string
  signal: AbortSignal
}

type Adapter = (ctx: AdapterContext) => Promise<{ ok: true; raw: RawAudio } | { ok: false; error: string }>

// —— 火山豆包：POST /api/v1/tts，JSON 响应内嵌 base64 ——
const volcanoAdapter: Adapter = async (ctx) => {
  const { settings } = ctx
  if (!settings.appid) return { ok: false, error: '未配置火山 App ID。' }
  const base = settings.baseUrl.replace(/\/+$/, '')
  const url = /\/api\/v1\/tts$/.test(base) ? base : `${base}/api/v1/tts`
  const guard = await guardOutboundUrl(url)
  if (!guard.ok || !guard.url) return { ok: false, error: `端点被拒绝：${guard.error ?? 'URL 不安全'}` }

  const body = {
    app: { appid: settings.appid, token: 'access_token', cluster: settings.cluster },
    user: { uid: 'codelf' },
    audio: { voice_type: ctx.voice, encoding: ctx.encoding, speed_ratio: ctx.speed },
    request: { reqid: randomUUID(), text: ctx.text, operation: 'query' }
  }
  const resp = await fetch(guard.url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 火山语音特有写法：Bearer 与分号之间无空格，token 跟在分号后。
      'Authorization': `Bearer;${ctx.token}`,
      'User-Agent': userAgent('audio_gen')
    },
    body: JSON.stringify(body),
    signal: ctx.signal,
    ...(getFetchOptions() ?? {})
  })
  const raw = await resp.text()
  if (!resp.ok) return { ok: false, error: `语音合成失败 HTTP ${resp.status}：${raw.slice(0, 300)}` }
  let json: { code?: number; message?: string; data?: string }
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: '语音端点响应不是有效 JSON。' }
  }
  if (json.code !== undefined && json.code !== 3000) {
    return { ok: false, error: `语音合成失败（code ${json.code}）：${json.message ?? '未知错误'}` }
  }
  if (!json.data) return { ok: false, error: '语音合成成功但未返回音频数据。' }
  const buffer = Buffer.from(json.data, 'base64')
  if (buffer.length === 0) return { ok: false, error: '返回的音频数据为空。' }
  return { ok: true, raw: { buffer, mime: mimeForEncoding(ctx.encoding), ext: extForFormat(ctx.encoding) } }
}

// —— OpenAI 兼容：POST /v1/audio/speech，直接返回二进制音频流 ——
const openaiAdapter: Adapter = async (ctx) => {
  const { settings } = ctx
  if (!settings.model) return { ok: false, error: '未配置模型名（如 tts-1 / gpt-4o-mini-tts）。' }
  const base = settings.baseUrl.replace(/\/+$/, '')
  const url = /\/audio\/speech$/.test(base) ? base : `${base}/audio/speech`
  const guard = await guardOutboundUrl(url)
  if (!guard.ok || !guard.url) return { ok: false, error: `端点被拒绝：${guard.error ?? 'URL 不安全'}` }

  // OpenAI 的 response_format 用 mp3/wav/opus/pcm/aac/flac；把内部 encoding 归一。
  const fmt = ctx.encoding.includes('wav') ? 'wav' : ctx.encoding.includes('opus') || ctx.encoding.includes('ogg') ? 'opus' : ctx.encoding.includes('pcm') ? 'pcm' : 'mp3'
  const body = { model: settings.model, input: ctx.text, voice: ctx.voice, response_format: fmt, speed: ctx.speed }
  const resp = await fetch(guard.url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ctx.token}`,
      'User-Agent': userAgent('audio_gen')
    },
    body: JSON.stringify(body),
    signal: ctx.signal,
    ...(getFetchOptions() ?? {})
  })
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    let detail = txt
    try {
      const j = JSON.parse(txt) as { error?: { message?: string } }
      if (j.error?.message) detail = j.error.message
    } catch { /* keep */ }
    return { ok: false, error: `语音合成失败 HTTP ${resp.status}：${detail.slice(0, 300)}` }
  }
  const buffer = Buffer.from(await resp.arrayBuffer())
  if (buffer.length === 0) return { ok: false, error: '返回的音频数据为空。' }
  const mime = resp.headers.get('content-type') ?? mimeForEncoding(fmt)
  return { ok: true, raw: { buffer, mime, ext: extForFormat(fmt) } }
}

// —— MiniMax T2A v2：POST /v1/t2a_v2?GroupId=xxx，JSON 响应 data.audio 为 hex ——
const minimaxAdapter: Adapter = async (ctx) => {
  const { settings } = ctx
  if (!settings.groupId) return { ok: false, error: '未配置 MiniMax group_id。' }
  if (!settings.model) return { ok: false, error: '未配置模型名（如 speech-01-turbo）。' }
  const base = settings.baseUrl.replace(/\/+$/, '')
  const path = /\/t2a_v2$/.test(base) ? base : `${base}/t2a_v2`
  const url = `${path}?GroupId=${encodeURIComponent(settings.groupId)}`
  const guard = await guardOutboundUrl(url)
  if (!guard.ok || !guard.url) return { ok: false, error: `端点被拒绝：${guard.error ?? 'URL 不安全'}` }

  // MiniMax T2A v2 仅支持 mp3/pcm/flac，不支持 wav；wav 回退到 mp3。
  const fmt = ctx.encoding.includes('pcm') ? 'pcm' : ctx.encoding.includes('flac') ? 'flac' : 'mp3'
  const body = {
    model: settings.model,
    text: ctx.text,
    stream: false,
    voice_setting: { voice_id: ctx.voice, speed: ctx.speed },
    audio_setting: { format: fmt }
  }
  const resp = await fetch(guard.url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ctx.token}`,
      'User-Agent': userAgent('audio_gen')
    },
    body: JSON.stringify(body),
    signal: ctx.signal,
    ...(getFetchOptions() ?? {})
  })
  const raw = await resp.text()
  if (!resp.ok) return { ok: false, error: `语音合成失败 HTTP ${resp.status}：${raw.slice(0, 300)}` }
  let json: { data?: { audio?: string }; base_resp?: { status_code?: number; status_msg?: string } }
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: '语音端点响应不是有效 JSON。' }
  }
  const code = json.base_resp?.status_code
  if (code !== undefined && code !== 0) {
    return { ok: false, error: `语音合成失败（code ${code}）：${json.base_resp?.status_msg ?? '未知错误'}` }
  }
  const hex = json.data?.audio
  if (!hex) return { ok: false, error: '语音合成成功但未返回音频数据。' }
  const buffer = Buffer.from(hex, 'hex')
  if (buffer.length === 0) return { ok: false, error: '返回的音频数据为空。' }
  return { ok: true, raw: { buffer, mime: mimeForEncoding(fmt), ext: extForFormat(fmt) } }
}

const ADAPTERS: Record<AudioGenSettings['provider'], Adapter> = {
  volcano: volcanoAdapter,
  openai: openaiAdapter,
  minimax: minimaxAdapter
}

// 文生音：按 provider 选择适配器调用对应端点，得到音频并落盘。
export async function generateSpeech(
  req: AudioGenRequest,
  opts?: { persist?: boolean; signal?: AbortSignal }
): Promise<AudioGenOutcome> {
  const settings = getAudioGenSettings()
  if (!settings.enabled) return { ok: false, error: '文生音未启用，请在「文生音」设置中开启并配置端点。' }
  if (!settings.baseUrl) return { ok: false, error: '未配置语音端点 Base URL。' }
  const token = getSecret(AUDIO_GEN_KEY_REF)
  if (!token) return { ok: false, error: '未配置语音端点 API Key / Token。' }

  const text = req.text?.trim()
  if (!text) return { ok: false, error: '合成文本为空。' }

  const encoding = (req.encoding || settings.encoding).toLowerCase()
  const speed = typeof req.speed === 'number' && Number.isFinite(req.speed)
    ? Math.min(2, Math.max(0.5, req.speed))
    : settings.speed
  const voice = req.voice || settings.voiceType

  const adapter = ADAPTERS[settings.provider]
  if (!adapter) return { ok: false, error: `不支持的语音供应商：${settings.provider}` }

  const t = withTimeout(opts?.signal, settings.timeoutMs)
  let result: { ok: true; raw: RawAudio } | { ok: false; error: string }
  try {
    result = await adapter({ settings, token, voice, encoding, speed, text, signal: t.signal })
  } catch (e) {
    t.clear()
    if (opts?.signal?.aborted) return { ok: false, error: '已取消' }
    return { ok: false, error: describeFetchError(e) }
  }
  t.clear()

  if (!result.ok) return { ok: false, error: result.error }

  const { buffer, mime, ext } = result.raw
  if (opts?.persist === false) {
    return { ok: true, firstDataUrl: `data:${mime};base64,${buffer.toString('base64')}` }
  }
  const saved = await saveGeneratedAudio(buffer, ext)
  return { ok: true, audio: saved, firstDataUrl: `data:${mime};base64,${buffer.toString('base64')}` }
}
