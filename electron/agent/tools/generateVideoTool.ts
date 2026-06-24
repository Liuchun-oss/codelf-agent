import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { generateVideo } from '../services/videoGenService'
import { GENERATE_VIDEO_NAME, GENERATE_VIDEO_DESCRIPTION } from '../prompts/tools/videoGen'

const generateVideoSchema = z.object({
  prompt: z.string().min(1).describe('Detailed description of the video: subject, motion, camera movement, mood'),
  firstFrame: z.string().optional().describe('Optional first-frame reference image (image-to-video). http(s) URL, codelf-artifact:// URL, absolute path, or workspace-relative path.'),
  lastFrame: z.string().optional().describe('Optional last-frame reference image (first+last frame interpolation).'),
  referenceImages: z.array(z.string().min(1)).optional().describe('Optional additional reference image(s) for style/subject guidance.'),
  resolution: z.string().optional().describe('Resolution: "480p", "720p", or "1080p". Defaults to configured value.'),
  duration: z.number().int().min(1).max(30).optional().describe('Video length in seconds. Defaults to configured value.'),
  ratio: z.string().optional().describe('Aspect ratio like "16:9", "9:16", "1:1". Defaults to configured value.'),
  generateAudio: z.boolean().optional().describe('Set true to also generate audio (model-dependent, usually costs more).')
})

type GenerateVideoInput = z.infer<typeof generateVideoSchema>

export const generateVideoTool: Tool<GenerateVideoInput> = {
  name: GENERATE_VIDEO_NAME,
  description: GENERATE_VIDEO_DESCRIPTION,
  schema: generateVideoSchema,
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
    emit('正在提交视频生成任务…', 'running')

    const outcome = await generateVideo(
      {
        prompt: input.prompt,
        firstFrame: input.firstFrame,
        lastFrame: input.lastFrame,
        referenceImages: input.referenceImages,
        resolution: input.resolution,
        duration: input.duration,
        ratio: input.ratio,
        generateAudio: input.generateAudio,
        workspaceRoot: ctx.workspaceRoot
      },
      {
        signal: ctx.signal,
        onProgress: (message) => emit(message, 'running')
      }
    )

    if (!outcome.ok || (!outcome.video && !outcome.remoteUrl)) {
      emit(outcome.error ?? '视频生成失败。', 'error')
      return { content: outcome.error ?? '视频生成失败。', isError: true }
    }

    emit('视频已生成', 'completed')
    if (outcome.video?.url) {
      return {
        content: `已生成视频并在界面中以播放器展示给用户。无需在回复里重复粘贴视频 markdown 或 URL。\n\n![video](${outcome.video.url})`
      }
    }
    // 仅有远程签名 URL（本地保存失败）：给可点击链接，提示 24h 有效。
    const remote = outcome.remoteUrl ?? ''
    return {
      content: `视频已生成，但本地保存失败，只能提供临时下载链接（24 小时内有效，请尽快下载保存）：\n\n[点击下载视频](${remote})`
    }
  }
}
