import { getImageGenSettings } from '../settings/agentSettingsStore'
import { getSecret } from '../../ipc/secrets'
import { guardOutboundUrl } from '../tools/ssrfGuard'
import { getFetchOptions } from '../providers/network'
import { saveGeneratedImage, type SavedGeneratedImage, type SaveImageTarget } from '../../services/generatedImageStore'
import { userAgent, ARTIFACT_FILE_SCHEME, isVolcEndpoint } from '@shared/appConfig'
import { readFile } from 'fs/promises'
import { isAbsolute, resolve as resolvePath, basename } from 'path'

// 独立图像端点的 API Key 在 secrets 存储里的引用名。
export const IMAGE_GEN_KEY_REF = 'imagegen:apiKey'

export interface ImageGenRequest {
  prompt: string
  size?: string
  n?: number
  // 参考图（图生图 / 多图参考 / 融合）：可为 http(s) URL 或本地引用
  // （codelf-artifact://、绝对路径、工作区相对路径）。本地引用会被读为 base64。
  images?: string[]
  // 组图：开启后让模型自动生成一组连贯图片（火山 Seedream sequential_image_generation）。
  series?: boolean
  // 组图最大张数（配合 series 使用）。
  maxImages?: number
  // 解析本地参考图引用所需的工作区根。
  workspaceRoot?: string | null
  // agent 指定的输出文件路径（含文件名+扩展名）；多张时自动按 -1/-2… 编号。
  outputPath?: string
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

// 下载远程图片并转 base64（用于端点只返回 URL 的回退路径）。
async function downloadImageAsBase64(url: string, signal?: AbortSignal): Promise<string | null> {
  const guard = await guardOutboundUrl(url)
  if (!guard.ok || !guard.url) return null
  const resp = await fetch(guard.url.toString(), {
    headers: { 'User-Agent': userAgent('image_gen') },
    signal,
    ...(getFetchOptions() ?? {})
  })
  if (!resp.ok) return null
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length === 0) return null
  return buf.toString('base64')
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
  // 落盘目标（含 outputPath / multi）；为空则用默认随机命名。
  saveTarget?: SaveImageTarget
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
    const urlList = (json.data ?? [])
      .map((d) => d.url)
      .filter((u): u is string => typeof u === 'string' && u.length > 0)

    // 优先用 base64；没有 base64 时回退到下载 URL（火山在 response_format=url 或
    // 部分网关下只返回 URL）。两种模式都兜住，避免"只支持 b64"导致的失败。
    let resolvedB64 = b64List
    if (resolvedB64.length === 0 && urlList.length > 0) {
      const downloaded: string[] = []
      for (const u of urlList) {
        const b64 = await downloadImageAsBase64(u, cfg.signal).catch(() => null)
        if (b64) downloaded.push(b64)
      }
      resolvedB64 = downloaded
    }

    if (resolvedB64.length === 0) {
      return { ok: false, error: cfg.emptyDataError }
    }

    if (!cfg.persist) {
      return { ok: true, firstDataUrl: `data:image/png;base64,${resolvedB64[0]}` }
    }
    const saved: SavedGeneratedImage[] = []
    for (let i = 0; i < resolvedB64.length; i += 1) {
      saved.push(await saveGeneratedImage(resolvedB64[i], 'image/png', cfg.saveTarget, i))
    }
    return { ok: true, images: saved, firstDataUrl: `data:image/png;base64,${resolvedB64[0]}` }
  }
  return { ok: false, error: lastError }
}

// 把请求尺寸规整为图像端点能接受的值。
// 火山 Seedream 4.x 要求像素总量较大（约 ≥368 万像素 / 2K 级），
// 像 1024x1024(=105万) 这类小尺寸会被直接拒绝（HTTP 400 size too small）。
// 这里把过小或不带档位关键字的小尺寸抬到 2K，避免模型误传小尺寸导致失败。
function normalizeRequestSize(raw: string): string {
  const s = (raw || '').trim()
  if (!s) return '2K'
  // 档位关键字（1K/2K/4K）直接交给端点。
  if (/^[124]k$/i.test(s)) return s.toUpperCase()
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(s)
  if (m) {
    const w = parseInt(m[1], 10)
    const h = parseInt(m[2], 10)
    if (Number.isFinite(w) && Number.isFinite(h)) {
      // 低于约 368 万像素的，抬到 2K 档（端点会按比例给到合规尺寸）。
      if (w * h < 3_680_000) return '2K'
      return `${w}x${h}`
    }
  }
  // auto 或无法识别：交给 2K，最稳。
  return '2K'
}

export async function generateImages(
  req: ImageGenRequest,
  opts?: {
    persist?: boolean
    signal?: AbortSignal
    onRetry?: (attempt: number, reason: string) => void
    // 流式：每生成一张就回调一次（dataUrl 可直接预览）。设置后请求体启用 stream。
    stream?: boolean
    onPartialImage?: (index: number, dataUrl: string) => void
  }
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

  const n = req.n && req.n > 0 ? Math.min(req.n, 4) : 1
  // 落盘目标：multi 取决于是否可能产出多张（series 或 n>1 或 maxImages>1）。
  const willBeMulti = Boolean(req.series) || n > 1 || (req.maxImages ?? 0) > 1
  const saveTarget: SaveImageTarget | undefined = req.outputPath
    ? { outputPath: req.outputPath, workspaceRoot: req.workspaceRoot ?? null, multi: willBeMulti }
    : undefined
  const body: Record<string, unknown> = {
    model: settings.model,
    prompt: req.prompt,
    size: normalizeRequestSize(req.size || settings.size),
    response_format: 'b64_json'
  }
  // watermark 是火山方舟私有参数；非火山端点开启严格校验时会拒绝该字段，故只对火山端点透传。
  if (isVolcEndpoint(settings.baseUrl)) {
    body.watermark = settings.watermark
  }

  // 参考图（图生图 / 多图参考 / 融合）：把本地引用解析为 data URL，http(s) 原样透传。
  if (req.images?.length) {
    const resolved: string[] = []
    for (const ref of req.images) {
      const r = await resolveImageForRequest(ref, req.workspaceRoot ?? null)
      if ('error' in r) return { ok: false, error: r.error }
      resolved.push(r.value)
    }
    // 火山约定：单图传字符串，多图传数组。
    body.image = resolved.length === 1 ? resolved[0] : resolved
  }

  // 组图：开启后由模型自动决定生成一组连贯图片；否则按需要的张数（n>1 时也用组图实现）。
  if (req.series) {
    body.sequential_image_generation = 'auto'
    body.sequential_image_generation_options = { max_images: Math.min(Math.max(req.maxImages ?? n, 1), 15) }
  } else if (n > 1) {
    body.sequential_image_generation = 'auto'
    body.sequential_image_generation_options = { max_images: n }
  } else {
    body.sequential_image_generation = 'disabled'
    body.n = 1
  }
  const url = guard.url.toString()

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'User-Agent': userAgent('image_gen')
  }

  // 流式：火山 SSE 逐张返回（image_generation.partial_succeeded）。
  // 出错时回退到非流式整批请求，保证最终仍能出图。
  if (opts?.stream) {
    const streamed = await runImageStream({
      url,
      headers,
      body: { ...body, stream: true },
      signal: opts.signal,
      timeoutMs: settings.timeoutMs,
      persist: opts.persist !== false,
      onPartialImage: opts.onPartialImage,
      saveTarget
    }).catch((e) => ({ ok: false as const, error: describeFetchError(e) }))
    if (streamed.ok && (streamed.images?.length || streamed.firstDataUrl)) return streamed
    opts.onRetry?.(0, '流式失败，回退非流式')
  }

  return runImageRequestWithRetry({
    signal: opts?.signal,
    timeoutMs: settings.timeoutMs,
    persist: opts?.persist !== false,
    httpErrorPrefix: '图像端点返回',
    emptyDataError: '端点未返回任何图片数据。',
    onRetry: opts?.onRetry,
    saveTarget,
    doFetch: (signal) =>
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
        ...(getFetchOptions() ?? {})
      })
  })
}

interface ImageStreamConfig {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  signal?: AbortSignal
  timeoutMs: number
  persist: boolean
  onPartialImage?: (index: number, dataUrl: string) => void
  // 落盘目标（含 outputPath / multi）；为空则用默认随机命名。
  saveTarget?: SaveImageTarget
}

interface SseImageEvent {
  type?: string
  image_index?: number
  url?: string
  b64_json?: string
  error?: { message?: string }
}

// 解析火山图片生成 SSE 流：逐张回调预览 + 收集结果落盘。
async function runImageStream(cfg: ImageStreamConfig): Promise<ImageGenOutcome> {
  const t = withTimeout(cfg.signal, cfg.timeoutMs)
  let resp: Response
  try {
    resp = await fetch(cfg.url, {
      method: 'POST',
      headers: { ...cfg.headers, Accept: 'text/event-stream' },
      body: JSON.stringify(cfg.body),
      signal: t.signal,
      ...(getFetchOptions() ?? {})
    })
  } catch (e) {
    t.clear()
    if (cfg.signal?.aborted) return { ok: false, error: '已取消' }
    throw e
  }

  if (!resp.ok || !resp.body) {
    t.clear()
    const text = await resp.text().catch(() => '')
    return { ok: false, error: `图像端点返回 HTTP ${resp.status}：${text.slice(0, 300)}` }
  }

  const saved: SavedGeneratedImage[] = []
  let firstDataUrl: string | undefined
  let lastError = ''
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  const handleEvent = async (raw: string): Promise<void> => {
    const dataLines = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
    if (dataLines.length === 0) return
    const payload = dataLines.join('')
    if (!payload || payload === '[DONE]') return
    let ev: SseImageEvent
    try {
      ev = JSON.parse(payload) as SseImageEvent
    } catch {
      return
    }
    if (ev.type === 'image_generation.partial_failed') {
      lastError = ev.error?.message ?? '某张图片生成失败'
      return
    }
    if (ev.type !== 'image_generation.partial_succeeded') return
    let b64 = ev.b64_json
    if (!b64 && ev.url) b64 = (await downloadImageAsBase64(ev.url, cfg.signal).catch(() => null)) ?? undefined
    if (!b64) return
    const dataUrl = `data:image/png;base64,${b64}`
    if (!firstDataUrl) firstDataUrl = dataUrl
    cfg.onPartialImage?.(ev.image_index ?? saved.length, dataUrl)
    if (cfg.persist) saved.push(await saveGeneratedImage(b64, 'image/png', cfg.saveTarget, saved.length))
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        await handleEvent(chunk)
      }
    }
    if (buf.trim()) await handleEvent(buf)
  } finally {
    t.clear()
    reader.releaseLock()
  }

  if (!firstDataUrl) return { ok: false, error: lastError || '流式未返回任何图片。' }
  if (!cfg.persist) return { ok: true, firstDataUrl }
  return { ok: true, images: saved, firstDataUrl }
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

// 把图片引用规整为可放进请求体的形式：
// - http(s) URL 原样返回（火山支持直接传 URL）；
// - 本地引用（codelf-artifact://、绝对/相对路径）读为 data URL。
async function resolveImageForRequest(
  ref: string,
  workspaceRoot: string | null
): Promise<{ value: string } | { error: string }> {
  const trimmed = ref.trim()
  if (/^https?:\/\//i.test(trimmed)) return { value: trimmed }
  const resolved = await resolveImageRef(trimmed, workspaceRoot)
  if ('error' in resolved) return resolved
  return { value: `data:image/png;base64,${resolved.buffer.toString('base64')}` }
}

export interface ImageEditRequest {
  prompt: string
  imageRefs: string[]
  size?: string
  n?: number
  // agent 指定的输出文件路径（含文件名+扩展名）；多张时自动按 -1/-2… 编号。
  outputPath?: string
  // 解析 outputPath 相对路径所需的工作区根。
  workspaceRoot?: string | null
}

// 图片编辑入口。不同后端的编辑机制不同：
// - 火山方舟 / 多数兼容网关：编辑就是「带 image 参数的 generations」，没有独立 edits 端点；
// - OpenAI：编辑走独立的 multipart /images/edits 端点。
// 策略：先走 generations+image（火山可用，且能复用流式/尺寸兜底/重试/URL 回退），
// 失败再回退到 OpenAI 风格的 multipart /images/edits，两类后端都兼容。
export async function editImages(
  req: ImageEditRequest,
  opts?: {
    persist?: boolean
    signal?: AbortSignal
    workspaceRoot?: string | null
    onRetry?: (attempt: number, reason: string) => void
    stream?: boolean
    onPartialImage?: (index: number, dataUrl: string) => void
  }
): Promise<ImageGenOutcome> {
  if (!req.imageRefs?.length) return { ok: false, error: '缺少要编辑的源图片。' }

  const viaGenerations = await generateImages(
    {
      prompt: req.prompt,
      size: req.size,
      n: req.n,
      images: req.imageRefs,
      workspaceRoot: opts?.workspaceRoot ?? req.workspaceRoot ?? null,
      outputPath: req.outputPath
    },
    {
      persist: opts?.persist,
      signal: opts?.signal,
      onRetry: opts?.onRetry,
      stream: opts?.stream,
      onPartialImage: opts?.onPartialImage
    }
  )
  if (viaGenerations.ok && (viaGenerations.images?.length || viaGenerations.firstDataUrl)) {
    return viaGenerations
  }
  if (opts?.signal?.aborted) return viaGenerations

  // 回退：OpenAI 风格 multipart /images/edits。
  opts?.onRetry?.(0, 'generations 编辑失败，回退 /images/edits')
  return editImagesViaMultipart(req, opts)
}

// 用 OpenAI Images Edit API（POST {baseUrl}/images/edits，multipart）在原图基础上修改。
// gpt-image-1 支持；dall-e-3 不支持编辑。火山方舟无此端点（会 404，由上层回退逻辑兜住）。
async function editImagesViaMultipart(
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
  const editN = req.n && req.n > 0 ? Math.min(req.n, 4) : 1
  const saveTarget: SaveImageTarget | undefined = req.outputPath
    ? {
        outputPath: req.outputPath,
        workspaceRoot: opts?.workspaceRoot ?? req.workspaceRoot ?? null,
        multi: editN > 1
      }
    : undefined
  // FormData/Blob 的 body 一旦被 fetch 消费就不可复用，故每次尝试都重建。
  const buildForm = (): FormData => {
    const form = new FormData()
    form.append('model', settings.model)
    form.append('prompt', req.prompt)
    form.append('n', String(req.n && req.n > 0 ? Math.min(req.n, 4) : 1))
    form.append('size', req.size || settings.size)
    // watermark 为火山方舟私有参数，仅对火山端点透传，避免其它端点严格校验拒绝。
    if (isVolcEndpoint(settings.baseUrl)) {
      form.append('watermark', String(settings.watermark))
    }
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
    saveTarget,
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
