import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { generateImages, editImages } from '../services/imageGenService'
import { GENERATE_IMAGE_NAME, GENERATE_IMAGE_DESCRIPTION, EDIT_IMAGE_NAME, EDIT_IMAGE_DESCRIPTION } from '../prompts/tools/imageGen'

const generateImageSchema = z.object({
  prompt: z.string().min(1).describe('Detailed description of the image to generate'),
  size: z.string().optional().describe('Image size, e.g. "1024x1024", "1024x1536", "1536x1024", or "auto"'),
  n: z.number().int().min(1).max(4).optional().describe('Number of images to generate (1-4, default 1)')
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
        { prompt: input.prompt, size: input.size, n: input.n },
        {
          signal: ctx.signal,
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
    return { content: `已生成 ${outcome.images.length} 张图片并已在界面中展示给用户。无需在回复里重复粘贴图片 markdown 或 URL（URL 很长且易出错）。如需基于此图修改，用 EditImage 并传入该 URL。\n\n${md}` }
  }
}

const editImageSchema = z.object({
  imageRefs: z.array(z.string().min(1)).min(1).describe('References to source image(s): codelf-artifact:// URL of a previously generated image, absolute path, or workspace-relative path'),
  prompt: z.string().min(1).describe('Edit instruction describing what to change'),
  size: z.string().optional().describe('Image size, e.g. "1024x1024", "1024x1536", "1536x1024", or "auto"'),
  n: z.number().int().min(1).max(4).optional().describe('Number of images to generate (1-4, default 1)')
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
    const startedAt = Date.now()
    emit('正在调用图像端点编辑中…', 'running')
    const heartbeat = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000)
      emit(`图片编辑中…已用时 ${secs}s`, 'running')
    }, 2000)

    let outcome
    try {
      outcome = await editImages(
        { prompt: input.prompt, imageRefs: input.imageRefs, size: input.size, n: input.n },
        {
          signal: ctx.signal,
          workspaceRoot: ctx.workspaceRoot,
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
    return { content: `已基于原图编辑生成 ${outcome.images.length} 张图片并已在界面中展示给用户。无需在回复里重复粘贴图片 markdown 或 URL。\n\n${md}` }
  }
}
