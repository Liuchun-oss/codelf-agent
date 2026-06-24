import { getVideoGenSettings } from '../settings/agentSettingsStore'
import { getSecret } from '../../ipc/secrets'
import { guardOutboundUrl } from '../tools/ssrfGuard'
import { getFetchOptions } from '../providers/network'
import { saveGeneratedVideo, type SavedGeneratedVideo } from '../../services/generatedVideoStore'
import { userAgent, ARTIFACT_FILE_SCHEME } from '@shared/appConfig'
import { readFile } from 'fs/promises'
import { isAbsolute, resolve as resolvePath } from 'path'

// 视频端点的 API Key 在 secrets 存储里的引用名。
export const VIDEO_GEN_KEY_REF = 'videogen:apiKey'

export interface VideoGenRequest {
  prompt: string
  // 首帧参考图（图生视频）。可为 http(s) URL 或本地引用。
  firstFrame?: string
  // 尾帧参考图（首尾帧模式，部分模型支持）。
  lastFrame?: string
  // 额外参考图（多参考素材）。
  referenceImages?: string[]
  resolution?: string
  duration?: number
  ratio?: string
  generateAudio?: boolean
  workspaceRoot?: string | null
}

export interface VideoGenOutcome {
  ok: boolean
  error?: string
  video?: SavedGeneratedVideo
  // 火山原始签名 URL（落盘失败时仍可回退给用户）。
  remoteUrl?: string
}

type ProgressFn = (message: string) => void

interface TaskCreateResponse {
  id?: string
  error?: { message?: string; code?: string }
}

interface TaskQueryResponse {
  id?: string
  status?: string
  content?: { video_url?: string }
  error?: { message?: string; code?: string }
}

function describeFetchError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const cause = (e as { cause?: unknown })?.cause
  if (cause) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause)
    const code = (cause as { code?: unknown })?.code
    const codeStr = typeof code === 'string' ? `${code}: ` : ''
    if (causeMsg && causeMsg !== msg) return `请求视频端点失败：${msg}（${codeStr}${causeMsg}）`
  }
  return `请求视频端点失败：${msg}`
}

// POST {baseUrl}/contents/generations/tasks
function buildCreateEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/contents\/generations\/tasks$/.test(trimmed)) return trimmed
  return `${trimmed}/contents/generations/tasks`
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// 把本地图片引用解析为 data URL；http(s) 原样返回。
async function resolveImageRef(ref: string, workspaceRoot: string | null): Promise<string | { error: string }> {
  const trimmed = ref.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  let filePath = trimmed
  if (filePath.startsWith(`${ARTIFACT_FILE_SCHEME}://`)) {
    try {
      const parsed = new URL(filePath)
      let p = decodeURIComponent(parsed.pathname)
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
      filePath = p
    } catch {
      return { error: `无法解析图片引用：${ref}` }
    }
  }
  if (!isAbsolute(filePath)) {
    if (!workspaceRoot) return { error: `相对路径需要工作区根：${ref}` }
    filePath = resolvePath(workspaceRoot, filePath)
  }
  try {
    const buffer = await readFile(filePath)
    return `data:image/png;base64,${buffer.toString('base64')}`
  } catch {
    return { error: `读取图片失败：${filePath}` }
  }
}

// 组装火山 content 数组（text + 可选 image_url 素材）。
async function buildContent(req: VideoGenRequest): Promise<unknown[] | { error: string }> {
  const content: unknown[] = [{ type: 'text', text: req.prompt }]
  const addImage = async (ref: string, role?: string): Promise<{ error: string } | null> => {
    const resolved = await resolveImageRef(ref, req.workspaceRoot ?? null)
    if (typeof resolved !== 'string') return resolved
    // 官方 spec：role 是 content item 的顶层字段（与 type/image_url/text 平级），
    // image_url 只含 url。
    const item: Record<string, unknown> = { type: 'image_url', image_url: { url: resolved } }
    if (role) item.role = role
    content.push(item)
    return null
  }
  if (req.firstFrame) {
    const err = await addImage(req.firstFrame, 'first_frame')
    if (err) return err
  }
  if (req.lastFrame) {
    const err = await addImage(req.lastFrame, 'last_frame')
    if (err) return err
  }
  for (const ref of req.referenceImages ?? []) {
    const err = await addImage(ref, 'reference_image')
    if (err) return err
  }
  return content
}

// 下载视频签名 URL 为本地文件。
async function downloadVideo(url: string, signal?: AbortSignal): Promise<SavedGeneratedVideo | null> {
  const guard = await guardOutboundUrl(url)
  if (!guard.ok || !guard.url) return null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const resp = await fetch(guard.url.toString(), {
        headers: { 'User-Agent': userAgent('video_gen') },
        signal,
        ...(getFetchOptions() ?? {})
      })
      if (!resp.ok) {
        if (attempt < 3) {
          await delay(attempt * 1000)
          continue
        }
        return null
      }
      const mime = resp.headers.get('content-type') ?? 'video/mp4'
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length === 0) return null
      return await saveGeneratedVideo(buf, mime)
    } catch {
      if (signal?.aborted) return null
      if (attempt < 3) {
        await delay(attempt * 1000)
        continue
      }
      return null
    }
  }
  return null
}

export async function generateVideo(
  req: VideoGenRequest,
  opts?: { signal?: AbortSignal; onProgress?: ProgressFn; persist?: boolean }
): Promise<VideoGenOutcome> {
  const settings = getVideoGenSettings()
  if (!settings.enabled) return { ok: false, error: '视频生成未启用，请在「视频生成」设置中开启并配置端点。' }
  if (!settings.baseUrl) return { ok: false, error: '未配置视频端点 Base URL。' }
  const apiKey = getSecret(VIDEO_GEN_KEY_REF)
  if (!apiKey) return { ok: false, error: '未配置视频端点 API Key。' }

  const createGuard = await guardOutboundUrl(buildCreateEndpoint(settings.baseUrl))
  if (!createGuard.ok || !createGuard.url) return { ok: false, error: `端点被拒绝：${createGuard.error ?? 'URL 不安全'}` }

  const content = await buildContent(req)
  if (!Array.isArray(content)) return { ok: false, error: content.error }

  const body: Record<string, unknown> = {
    model: settings.model,
    content,
    resolution: req.resolution || settings.resolution,
    duration: req.duration && req.duration > 0 ? req.duration : settings.duration,
    ratio: req.ratio || settings.ratio,
    watermark: settings.watermark,
    generate_audio: req.generateAudio ?? settings.generateAudio
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'User-Agent': userAgent('video_gen')
  }

  // —— 阶段一：创建任务 ——
  opts?.onProgress?.('正在提交视频生成任务…')
  let taskId: string
  try {
    const resp = await fetch(createGuard.url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: opts?.signal,
      ...(getFetchOptions() ?? {})
    })
    const text = await resp.text()
    let json: TaskCreateResponse = {}
    try { json = JSON.parse(text) as TaskCreateResponse } catch { /* keep */ }
    if (!resp.ok) {
      return { ok: false, error: `创建任务失败 HTTP ${resp.status}：${(json.error?.message ?? text).slice(0, 300)}` }
    }
    if (!json.id) return { ok: false, error: '创建任务成功但未返回任务 ID。' }
    taskId = json.id
  } catch (e) {
    if (opts?.signal?.aborted) return { ok: false, error: '已取消' }
    return { ok: false, error: describeFetchError(e) }
  }

  // —— 阶段二：轮询任务状态 ——
  const queryUrl = `${createGuard.url.toString().replace(/\/+$/, '')}/${encodeURIComponent(taskId)}`
  const queryGuard = await guardOutboundUrl(queryUrl)
  if (!queryGuard.ok || !queryGuard.url) return { ok: false, error: `查询端点被拒绝：${queryGuard.error ?? 'URL 不安全'}` }

  const startedAt = Date.now()
  const deadline = startedAt + settings.pollTimeoutMs
  let interval = 3000
  let videoUrl = ''

  for (;;) {
    if (opts?.signal?.aborted) return { ok: false, error: '已取消' }
    if (Date.now() > deadline) {
      return { ok: false, error: `视频生成超时（${Math.round(settings.pollTimeoutMs / 1000)}s 内未完成）。` }
    }
    await delay(interval)
    interval = Math.min(interval + 2000, 10000)

    let q: TaskQueryResponse
    try {
      const resp = await fetch(queryGuard.url.toString(), {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': userAgent('video_gen') },
        signal: opts?.signal,
        ...(getFetchOptions() ?? {})
      })
      const text = await resp.text()
      try { q = JSON.parse(text) as TaskQueryResponse } catch { q = {} }
      if (!resp.ok) {
        // 查询瞬时失败不立刻判死，继续轮询直到超时。
        opts?.onProgress?.(`查询任务返回 HTTP ${resp.status}，继续等待…`)
        continue
      }
    } catch {
      if (opts?.signal?.aborted) return { ok: false, error: '已取消' }
      opts?.onProgress?.('查询任务网络抖动，继续等待…')
      continue
    }

    const status = (q.status ?? '').toLowerCase()
    const secs = Math.round((Date.now() - startedAt) / 1000)
    if (status === 'succeeded') {
      videoUrl = q.content?.video_url ?? ''
      if (!videoUrl) return { ok: false, error: '任务成功但未返回视频 URL。' }
      break
    }
    if (status === 'failed') return { ok: false, error: `视频生成失败：${q.error?.message ?? '未知错误'}` }
    if (status === 'expired') return { ok: false, error: '视频任务已过期。' }
    if (status === 'cancelled') return { ok: false, error: '视频任务已被取消。' }
    if (status === 'queued') opts?.onProgress?.(`任务排队中…已等待 ${secs}s`)
    else opts?.onProgress?.(`视频生成中…已用时 ${secs}s`)
  }

  // —— 阶段三：下载转存 ——
  if (opts?.persist === false) return { ok: true, remoteUrl: videoUrl }
  opts?.onProgress?.('视频生成完成，正在下载…')
  const saved = await downloadVideo(videoUrl, opts?.signal)
  if (!saved) {
    // 落盘失败也把签名 URL 返回，用户仍可在 24h 内访问。
    return { ok: true, remoteUrl: videoUrl, error: '视频已生成但本地保存失败，已返回临时链接（24 小时内有效）。' }
  }
  return { ok: true, video: saved, remoteUrl: videoUrl }
}

// ———— 供后台任务队列复用的原子操作 ————

export interface SubmitResult {
  ok: boolean
  remoteTaskId?: string
  error?: string
}

// 仅提交任务，立即返回火山任务 ID（不轮询）。
export async function submitVideoTask(req: VideoGenRequest): Promise<SubmitResult> {
  const settings = getVideoGenSettings()
  if (!settings.enabled) return { ok: false, error: '视频生成未启用，请在「视频生成」设置中开启并配置端点。' }
  if (!settings.baseUrl) return { ok: false, error: '未配置视频端点 Base URL。' }
  const apiKey = getSecret(VIDEO_GEN_KEY_REF)
  if (!apiKey) return { ok: false, error: '未配置视频端点 API Key。' }

  const createGuard = await guardOutboundUrl(buildCreateEndpoint(settings.baseUrl))
  if (!createGuard.ok || !createGuard.url) return { ok: false, error: `端点被拒绝：${createGuard.error ?? 'URL 不安全'}` }

  const content = await buildContent(req)
  if (!Array.isArray(content)) return { ok: false, error: content.error }

  const body: Record<string, unknown> = {
    model: settings.model,
    content,
    resolution: req.resolution || settings.resolution,
    duration: req.duration && req.duration > 0 ? req.duration : settings.duration,
    ratio: req.ratio || settings.ratio,
    watermark: settings.watermark,
    generate_audio: req.generateAudio ?? settings.generateAudio
  }
  try {
    const resp = await fetch(createGuard.url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': userAgent('video_gen')
      },
      body: JSON.stringify(body),
      ...(getFetchOptions() ?? {})
    })
    const text = await resp.text()
    let json: TaskCreateResponse = {}
    try { json = JSON.parse(text) as TaskCreateResponse } catch { /* keep */ }
    if (!resp.ok) return { ok: false, error: `创建任务失败 HTTP ${resp.status}：${(json.error?.message ?? text).slice(0, 300)}` }
    if (!json.id) return { ok: false, error: '创建任务成功但未返回任务 ID。' }
    return { ok: true, remoteTaskId: json.id }
  } catch (e) {
    return { ok: false, error: describeFetchError(e) }
  }
}

export interface PollResult {
  // running 表示仍在进行（queued/running）；其余为终态。
  state: 'running' | 'succeeded' | 'failed'
  statusText?: string
  videoUrl?: string
  error?: string
}

// 查询一次任务状态（不循环）。供队列按自己的节奏轮询。
export async function pollVideoTaskOnce(remoteTaskId: string): Promise<PollResult> {
  const settings = getVideoGenSettings()
  const apiKey = getSecret(VIDEO_GEN_KEY_REF)
  if (!apiKey) return { state: 'failed', error: '未配置视频端点 API Key。' }

  const queryUrl = `${buildCreateEndpoint(settings.baseUrl).replace(/\/+$/, '')}/${encodeURIComponent(remoteTaskId)}`
  const queryGuard = await guardOutboundUrl(queryUrl)
  if (!queryGuard.ok || !queryGuard.url) return { state: 'failed', error: `查询端点被拒绝：${queryGuard.error ?? 'URL 不安全'}` }

  let q: TaskQueryResponse
  try {
    const resp = await fetch(queryGuard.url.toString(), {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': userAgent('video_gen') },
      ...(getFetchOptions() ?? {})
    })
    const text = await resp.text()
    try { q = JSON.parse(text) as TaskQueryResponse } catch { q = {} }
    // 查询瞬时失败：当作仍在运行，等下次轮询。
    if (!resp.ok) return { state: 'running', statusText: `查询返回 HTTP ${resp.status}，继续等待…` }
  } catch {
    return { state: 'running', statusText: '查询网络抖动，继续等待…' }
  }

  const status = (q.status ?? '').toLowerCase()
  if (status === 'succeeded') {
    const url = q.content?.video_url ?? ''
    if (!url) return { state: 'failed', error: '任务成功但未返回视频 URL。' }
    return { state: 'succeeded', videoUrl: url }
  }
  if (status === 'failed') return { state: 'failed', error: `视频生成失败：${q.error?.message ?? '未知错误'}` }
  if (status === 'expired') return { state: 'failed', error: '视频任务已过期。' }
  if (status === 'cancelled') return { state: 'failed', error: '视频任务已被取消。' }
  if (status === 'queued') return { state: 'running', statusText: '任务排队中…' }
  return { state: 'running', statusText: '视频生成中…' }
}

// 下载并保存视频，返回本地 artifact URL（失败返回 null）。
export async function downloadAndSaveVideo(videoUrl: string): Promise<string | null> {
  const saved = await downloadVideo(videoUrl)
  return saved?.url ?? null
}
