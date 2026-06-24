import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { enqueueVideoTask } from '../../services/videoTaskQueue'
import { getVideoGenSettings } from '../settings/agentSettingsStore'
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

    const settings = getVideoGenSettings()
    if (!settings.enabled) {
      emit('视频生成未启用。', 'error')
      return { content: '视频生成未启用，请在「视频生成」设置中开启并配置端点。', isError: true }
    }

    const task = enqueueVideoTask({
      prompt: input.prompt,
      resolution: input.resolution || settings.resolution,
      ratio: input.ratio || settings.ratio,
      duration: input.duration && input.duration > 0 ? input.duration : settings.duration,
      generateAudio: input.generateAudio ?? settings.generateAudio,
      req: {
        prompt: input.prompt,
        firstFrame: input.firstFrame,
        lastFrame: input.lastFrame,
        referenceImages: input.referenceImages,
        resolution: input.resolution,
        duration: input.duration,
        ratio: input.ratio,
        generateAudio: input.generateAudio,
        workspaceRoot: ctx.workspaceRoot
      }
    })

    emit('已加入视频生成队列，正在后台生成…', 'completed')
    return {
      content: `视频生成任务已加入后台队列（任务 ID: ${task.id}）。视频生成较慢，会在后台继续生成，进度和结果会显示在右侧「产物预览 → 视频队列」面板中，不影响当前对话。无需等待或重复提交；生成完成后用户可在视频队列里查看和播放。`
    }
  }
}
