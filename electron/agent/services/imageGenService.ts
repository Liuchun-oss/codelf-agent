import { getImageGenSettings } from '../settings/agentSettingsStore'
import { getSecret } from '../../ipc/secrets'
import { guardOutboundUrl } from '../tools/ssrfGuard'
import { getFetchOptions } from '../providers/network'
import { saveGeneratedImage, type SavedGeneratedImage } from '../../services/generatedImageStore'
import { userAgent, ARTIFACT_FILE_SCHEME } from '@shared/appConfig'
import { readFile } from 'fs/promises'
import { isAbsolute, resolve as resolvePath, basename } from 'path'

// 独立图像端点的 API Key 在 secrets 存储里的引用名。
export const IMAGE_GEN_KEY_REF = 'imagegen:apiKey'

export interface ImageGenRequest {
  prompt: string
  size?: string
  n?: number
}

export interface ImageGenOutcome {
  ok: boolean
  error?: string
  images?: SavedGeneratedImage[]
  // 用于测试预览：第一张图的 data URL（不落盘场景）。
  firstDataUrl?: string
}

interface ImagesApiResponse {
  data?: { b64_json?: string; url?: string }[]
  error?: { message?: string }
}

// "fetch failed" 是 undici 传输层的通用错误，真正原因藏在 error.cause 里。
// 把它展开，便于定位（超时 / DNS / TLS / 连接重置等）。
function describeFetchError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const cause = (e as { cause?: unknown })?.cause
  if (cause) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause)
    const code = (cause as { code?: unknown })?.code
    const codeStr = typeof code === 'string' ? `${code}: ` : ''
    if (causeMsg && causeMsg !== msg) return `请求图像端点失败：${msg}（${codeStr}${causeMsg}）`
  }
  return `请求图像端点失败：${msg}`
}

// 把外部 signal 和超时合并成一个 signal（超时后中断请求）。
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController()
  const onAbort = (): void => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => ctrl.abort(new Error(`图像请求超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs)
  return {
    signal: ctrl.signal,
    clear: () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }
}

// 把 OpenAI Images API 标准（POST {baseUrl}/images/generations）生成图片。
// baseUrl 应以 /v1 结尾或为根；我们按需补 /images/generations。
function buildEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/images\/generations$/.test(trimmed)) return trimmed
  return `${trimmed}/images/generations`
}

// 自动重试配置：针对中转网关常见的瞬时故障（Cloudflare 524 超时、502/503/504、429 限流、
// 以及传输层/超时中断）做有限次重试。永久性错误（4xx 鉴权、模型不支持等）不重试。
const MAX_IMAGE_ATTEMPTS = 3
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524])

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface ImageHttpConfig {
  doFetch: (signal: AbortSignal) => Promise<Response>
  signal?: AbortSignal
  timeoutMs: number
  persist: boolean
  httpErrorPrefix: string
  emptyDataError: string
  onRetry?: (attempt: number, reason: string) => void
}

// 执行一次图像 HTTP 请求并解析；对可重试错误自动重试（指数退避）。
async function runImageRequestWithRetry(cfg: ImageHttpConfig): Promise<ImageGenOutcome> {
  let lastError = '图像请求失败'
  for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS; attempt += 1) {
    if (cfg.signal?.aborted) return { ok: false, error: '已取消' }

    const t = withTimeout(cfg.signal, cfg.timeoutMs)
    let resp: Response
    try {
      resp = await cfg.doFetch(t.signal)
    } catch (e) {
      t.clear()
      if (cfg.signal?.aborted) return { ok: false, error: '已取消' }
      lastError = describeFetchError(e)
      if (attempt < MAX_IMAGE_ATTEMPTS) {
        cfg.onRetry?.(attempt, lastError)
        await delay(attempt * 1500)
        continue
      }
      return { ok: false, error: lastError }
    }
    t.clear()

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      let detail = text
      try {
        const parsed = JSON.parse(text) as ImagesApiResponse
        if (parsed.error?.message) detail = parsed.error.message
      } catch { /* keep raw text */ }
      lastError = `${cfg.httpErrorPrefix} HTTP ${resp.status}：${detail.slice(0, 300)}`
      if (RETRYABLE_STATUS.has(resp.status) && attempt < MAX_IMAGE_ATTEMPTS) {
        cfg.onRetry?.(attempt, `HTTP ${resp.status}`)
        await delay(attempt * 1500)
        continue
      }
      return { ok: false, error: lastError }
    }

    let json: ImagesApiResponse
    try {
      json = (await resp.json()) as ImagesApiResponse
    } catch {
      lastError = '图像端点响应不是有效 JSON。'
      if (attempt < MAX_IMAGE_ATTEMPTS) {
        cfg.onRetry?.(attempt, '响应非 JSON')
        await delay(attempt * 1500)
        continue
      }
      return { ok: false, error: lastError }
    }

    const b64List = (json.data ?? [])
      .map((d) => d.b64_json)
      .filter((b): b is string => typeof b === 'string' && b.length > 0)
    if (b64List.length === 0) {
      const hadUrl = (json.data ?? []).some((d) => typeof d.url === 'string')
      return {
        ok: false,
        error: hadUrl ? '端点返回的是图片 URL 而非 base64 数据，当前未支持该模式。' : cfg.emptyDataError
      }
    }

    if (!cfg.persist) {
      return { ok: true, firstDataUrl: `data:image/png;base64,${b64List[0]}` }
    }
    const saved: SavedGeneratedImage[] = []
    for (const b64 of b64List) saved.push(await saveGeneratedImage(b64, 'image/png'))
    return { ok: true, images: saved, firstDataUrl: `data:image/png;base64,${b64List[0]}` }
  }
  return { ok: false, error: lastError }
}

export async function generateImages(
  req: ImageGenRequest,
  opts?: { persist?: boolean; signal?: AbortSignal; onRetry?: (attempt: number, reason: string) => void }
): Promise<ImageGenOutcome> {
  const settings = getImageGenSettings()
  if (!settings.enabled) {
    return { ok: false, error: '图像生成未启用，请在「图像生成」设置中开启并配置端点。' }
  }
  if (!settings.baseUrl) {
    return { ok: false, error: '未配置图像端点 Base URL。' }
  }
  const apiKey = getSecret(IMAGE_GEN_KEY_REF)
  if (!apiKey) {
    return { ok: false, error: '未配置图像端点 API Key。' }
  }

  const endpoint = buildEndpoint(settings.baseUrl)
  const guard = await guardOutboundUrl(endpoint)
  if (!guard.ok || !guard.url) {
    return { ok: false, error: `端点被拒绝：${guard.error ?? 'URL 不安全'}` }
  }

  const body: Record<string, unknown> = {
    model: settings.model,
    prompt: req.prompt,
    n: req.n && req.n > 0 ? Math.min(req.n, 4) : 1,
    size: req.size || settings.size,
    response_format: 'b64_json'
  }
  const url = guard.url.toString()

  return runImageRequestWithRetry({
    signal: opts?.signal,
    timeoutMs: settings.timeoutMs,
    persist: opts?.persist !== false,
    httpErrorPrefix: '图像端点返回',
    emptyDataError: '端点未返回任何图片数据。',
    onRetry: opts?.onRetry,
    doFetch: (signal) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'User-Agent': userAgent('image_gen')
        },
        body: JSON.stringify(body),
        signal,
        ...(getFetchOptions() ?? {})
      })
  })
}

// 把 image edits 端点拼出来。
function buildEditEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/images\/edits$/.test(trimmed)) return trimmed
  return `${trimmed}/images/edits`
}

// 把 AI 给的图片引用解析为本地文件并读出内容。
// 支持：codelf-artifact://local/<path>、绝对路径、相对工作区根的路径。
async function resolveImageRef(
  ref: string,
  workspaceRoot: string | null
): Promise<{ buffer: Buffer; name: string } | { error: string }> {
  let filePath = ref.trim()
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
    return { buffer, name: basename(filePath) || 'image.png' }
  } catch {
    return { error: `读取图片失败：${filePath}` }
  }
}

export interface ImageEditRequest {
  prompt: string
  imageRefs: string[]
  size?: string
  n?: number
}

// 用 OpenAI Images Edit API（POST {baseUrl}/images/edits，multipart）在原图基础上修改。
// gpt-image-1 支持；dall-e-3 不支持编辑。
export async function editImages(
  req: ImageEditRequest,
  opts?: { persist?: boolean; signal?: AbortSignal; workspaceRoot?: string | null; onRetry?: (attempt: number, reason: string) => void }
): Promise<ImageGenOutcome> {
  const settings = getImageGenSettings()
  if (!settings.enabled) return { ok: false, error: '图像生成未启用，请在「图像生成」设置中开启并配置端点。' }
  if (!settings.baseUrl) return { ok: false, error: '未配置图像端点 Base URL。' }
  const apiKey = getSecret(IMAGE_GEN_KEY_REF)
  if (!apiKey) return { ok: false, error: '未配置图像端点 API Key。' }
  if (!req.imageRefs?.length) return { ok: false, error: '缺少要编辑的源图片。' }

  const guard = await guardOutboundUrl(buildEditEndpoint(settings.baseUrl))
  if (!guard.ok || !guard.url) return { ok: false, error: `端点被拒绝：${guard.error ?? 'URL 不安全'}` }

  // 先把源图解析为内存 buffer（只解析一次），供每次重试重建 FormData 使用。
  const resolvedImages: { buffer: Buffer; name: string }[] = []
  for (const ref of req.imageRefs) {
    const resolved = await resolveImageRef(ref, opts?.workspaceRoot ?? null)
    if ('error' in resolved) return { ok: false, error: resolved.error }
    resolvedImages.push(resolved)
  }

  const singleImage = resolvedImages.length === 1
  // FormData/Blob 的 body 一旦被 fetch 消费就不可复用，故每次尝试都重建。
  const buildForm = (): FormData => {
    const form = new FormData()
    form.append('model', settings.model)
    form.append('prompt', req.prompt)
    form.append('n', String(req.n && req.n > 0 ? Math.min(req.n, 4) : 1))
    form.append('size', req.size || settings.size)
    for (const img of resolvedImages) {
      const blob = new Blob([new Uint8Array(img.buffer)], { type: 'image/png' })
      // 单图用标准字段名 image；多图才用 image[]（部分网关只认 image）。
      form.append(singleImage ? 'image' : 'image[]', blob, img.name)
    }
    return form
  }
  const url = guard.url.toString()

  return runImageRequestWithRetry({
    signal: opts?.signal,
    timeoutMs: settings.timeoutMs,
    persist: opts?.persist !== false,
    httpErrorPrefix: '图像编辑端点返回',
    emptyDataError: '编辑端点未返回图片数据（可能不支持 b64_json 或该模型不支持编辑）。',
    onRetry: opts?.onRetry,
    doFetch: (signal) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'User-Agent': userAgent('image_edit')
        },
        body: buildForm(),
        signal,
        ...(getFetchOptions() ?? {})
      })
  })
}
