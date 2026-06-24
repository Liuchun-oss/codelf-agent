import { z } from 'zod'
import { isAbsolute, resolve as resolvePath, extname } from 'path'
import type { Tool, ToolResult } from './types'
import { generateImages, editImages } from '../services/imageGenService'
import { GENERATE_IMAGE_NAME, GENERATE_IMAGE_DESCRIPTION, EDIT_IMAGE_NAME, EDIT_IMAGE_DESCRIPTION } from '../prompts/tools/imageGen'

const IMAGE_OUTPUT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

// 校验并把 outputPath 解析为绝对路径（含文件名+图片扩展名）。
// 返回 string 表示成功，返回 { error } 表示校验失败。
function resolveImageOutputPath(
  raw: string | undefined,
  workspaceRoot: string | null
): string | { error: string } {
  const v = (raw ?? '').trim()
  if (!v) {
    return { error: 'outputPath 必填：请提供包含文件名和图片扩展名（.png/.jpg/.webp）的完整路径，例如 "images/icon.png"。' }
  }
  if (/[\\/]$/.test(v) || !IMAGE_OUTPUT_EXTS.has(extname(v).toLowerCase())) {
    return { error: `outputPath 必须是完整的文件路径，包含文件名和图片扩展名（.png/.jpg/.webp），不能只给目录。当前值："${v}"。请改成形如 "images/icon.png" 的路径。` }
  }
  if (isAbsolute(v)) return v
  if (!workspaceRoot) {
    return { error: 'outputPath 是相对路径，但当前没有打开工作区，无法解析。请改用绝对路径（包含文件名）。' }
  }
  return resolvePath(workspaceRoot, v)
}

const generateImageSchema = z.object({
  prompt: z.string().min(1).describe('Detailed description of the image to generate'),
  size: z.string().optional().describe('Image size. Prefer "2K" (default) or "4K"; small sizes like 1024x1024 are rejected by some endpoints. May also be an explicit large WIDTHxHEIGHT.'),
  n: z.number().int().min(1).max(4).optional().describe('Number of images to generate (1-4, default 1)'),
  referenceImages: z.array(z.string().min(1)).optional().describe('Optional reference image(s) for image-to-image, multi-image reference, or fusion. Each item is an http(s) URL, a codelf-artifact:// URL of a previously generated image, an absolute path, or a workspace-relative path. Pass one for single-image guidance, multiple for fusion/swap.'),
  series: z.boolean().optional().describe('Set true to generate a coherent SET of images in one call (e.g. four-seasons sequence, brand kit, a story across multiple scenes). The model auto-decides how many to produce up to maxImages.'),
  maxImages: z.number().int().min(1).max(15).optional().describe('When series=true, the max number of images to produce (1-15, default 4).'),
  outputPath: z.string().min(1).describe('REQUIRED. Full output file path INCLUDING the file name and an image extension (.png/.jpg/.webp), e.g. "images/icon.png" or "D:/assets/logo.png". Absolute or workspace-relative. A directory-only path is NOT accepted — you must specify the file name. When multiple images are produced (n>1 or series), each file gets a numeric suffix before the extension (icon.png → icon-1.png, icon-2.png …).')
})

type GenerateImageInput = z.infer<typeof generateImageSchema>

export const generateImageTool: Tool<GenerateImageInput> = {
  name: GENERATE_IMAGE_NAME,
  description: GENERATE_IMAGE_DESCRIPTION,
  schema: generateImageSchema,
  readOnly: true,
  concurrencySafe: false,
  deferred: true,
  supportsBackgroundExecution: true,
  async execute(input, ctx): Promise<ToolResult> {
    const emit = (message: string, status: 'running' | 'completed' | 'error'): void => {
      if (ctx.emitEvent && ctx.turnId && ctx.toolCallId) {
        ctx.emitEvent({ type: 'tool_call_progress', turnId: ctx.turnId, callId: ctx.toolCallId, status, message })
      }
    }
    const resolvedOutputPath = resolveImageOutputPath(input.outputPath, ctx.workspaceRoot)
    if (typeof resolvedOutputPath !== 'string') {
      emit(resolvedOutputPath.error, 'error')
      return { content: resolvedOutputPath.error, isError: true }
    }
    // Images API 是单次阻塞请求，没有原生流式进度。这里用心跳上报已用时，
    // 避免界面看起来卡死（误判为无响应）。
    const startedAt = Date.now()
    emit('正在调用图像端点生成中…', 'running')
    const heartbeat = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000)
      emit(`图片生成中…已用时 ${secs}s`, 'running')
    }, 2000)

    let outcome
    try {
      outcome = await generateImages(
        {
          prompt: input.prompt,
          size: input.size,
          n: input.n,
          images: input.referenceImages,
          series: input.series,
          maxImages: input.maxImages,
          workspaceRoot: ctx.workspaceRoot,
          outputPath: resolvedOutputPath
        },
        {
          signal: ctx.signal,
          stream: true,
          onPartialImage: (index, dataUrl) => {
            if (ctx.emitEvent && ctx.turnId) {
              ctx.emitEvent({ type: 'image_progress', turnId: ctx.turnId, index, dataUrl })
            }
            emit(`已生成第 ${index + 1} 张，继续生成中…`, 'running')
          },
          onRetry: (attempt, reason) => emit(`端点超时/不稳定（${reason}），正在自动重试（第 ${attempt + 1} 次）…`, 'running')
        }
      )
    } finally {
      clearInterval(heartbeat)
    }
    if (!outcome.ok || !outcome.images?.length) {
      emit(outcome.error ?? '图像生成失败。', 'error')
      return { content: outcome.error ?? '图像生成失败。', isError: true }
    }
    emit(`已生成 ${outcome.images.length} 张图片`, 'completed')
    const md = outcome.images.map((img) => `![生成的图片](${img.url})`).join('\n\n')
    const paths = outcome.images.map((img) => `- ${img.filePath}`).join('\n')
    return { content: `已生成 ${outcome.images.length} 张图片并已在界面中展示给用户，已保存到：\n${paths}\n\n无需在回复里重复粘贴图片 markdown 或 URL（URL 很长且易出错）。如需基于此图修改，用 EditImage 并传入该 URL。\n\n${md}` }
  }
}

const editImageSchema = z.object({
  imageRefs: z.array(z.string().min(1)).min(1).describe('References to source image(s): codelf-artifact:// URL of a previously generated image, absolute path, or workspace-relative path'),
  prompt: z.string().min(1).describe('Edit instruction describing what to change'),
  size: z.string().optional().describe('Image size, e.g. "1024x1024", "1024x1536", "1536x1024", or "auto"'),
  n: z.number().int().min(1).max(4).optional().describe('Number of images to generate (1-4, default 1)'),
  outputPath: z.string().min(1).describe('REQUIRED. Full output file path INCLUDING the file name and an image extension (.png/.jpg/.webp), e.g. "images/icon-edited.png". Absolute or workspace-relative. A directory-only path is NOT accepted. When n>1, each file gets a numeric suffix before the extension.')
})

type EditImageInput = z.infer<typeof editImageSchema>

export const editImageTool: Tool<EditImageInput> = {
  name: EDIT_IMAGE_NAME,
  description: EDIT_IMAGE_DESCRIPTION,
  schema: editImageSchema,
  readOnly: true,
  concurrencySafe: false,
  deferred: true,
  supportsBackgroundExecution: true,
  async execute(input, ctx): Promise<ToolResult> {
    const emit = (message: string, status: 'running' | 'completed' | 'error'): void => {
      if (ctx.emitEvent && ctx.turnId && ctx.toolCallId) {
        ctx.emitEvent({ type: 'tool_call_progress', turnId: ctx.turnId, callId: ctx.toolCallId, status, message })
      }
    }
    const resolvedOutputPath = resolveImageOutputPath(input.outputPath, ctx.workspaceRoot)
    if (typeof resolvedOutputPath !== 'string') {
      emit(resolvedOutputPath.error, 'error')
      return { content: resolvedOutputPath.error, isError: true }
    }
    const startedAt = Date.now()
    emit('正在调用图像端点编辑中…', 'running')
    const heartbeat = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000)
      emit(`图片编辑中…已用时 ${secs}s`, 'running')
    }, 2000)

    let outcome
    try {
      outcome = await editImages(
        { prompt: input.prompt, imageRefs: input.imageRefs, size: input.size, n: input.n, outputPath: resolvedOutputPath, workspaceRoot: ctx.workspaceRoot },
        {
          signal: ctx.signal,
          workspaceRoot: ctx.workspaceRoot,
          stream: true,
          onPartialImage: (index, dataUrl) => {
            if (ctx.emitEvent && ctx.turnId) {
              ctx.emitEvent({ type: 'image_progress', turnId: ctx.turnId, index, dataUrl })
            }
            emit(`已生成第 ${index + 1} 张，继续生成中…`, 'running')
          },
          onRetry: (attempt, reason) => emit(`端点超时/不稳定（${reason}），正在自动重试（第 ${attempt + 1} 次）…`, 'running')
        }
      )
    } finally {
      clearInterval(heartbeat)
    }
    if (!outcome.ok || !outcome.images?.length) {
      emit(outcome.error ?? '图像编辑失败。', 'error')
      return { content: outcome.error ?? '图像编辑失败。', isError: true }
    }
    emit(`已编辑生成 ${outcome.images.length} 张图片`, 'completed')
    const md = outcome.images.map((img) => `![编辑后的图片](${img.url})`).join('\n\n')
    const paths = outcome.images.map((img) => `- ${img.filePath}`).join('\n')
    return { content: `已基于原图编辑生成 ${outcome.images.length} 张图片并已在界面中展示给用户，已保存到：\n${paths}\n\n无需在回复里重复粘贴图片 markdown 或 URL。\n\n${md}` }
  }
}
