import { z } from 'zod'
import { isAbsolute, resolve as resolvePath, extname, basename } from 'path'
import type { Tool, ToolResult } from './types'
import { enqueueVideoTask } from '../../services/videoTaskQueue'
import { getVideoGenSettings } from '../settings/agentSettingsStore'
import { GENERATE_VIDEO_NAME, GENERATE_VIDEO_DESCRIPTION } from '../prompts/tools/videoGen'

const VIDEO_OUTPUT_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v'])

const generateVideoSchema = z.object({
  prompt: z.string().min(1).describe('Detailed description of the video: subject, motion, camera movement, mood'),
  firstFrame: z.string().optional().describe('Optional first-frame reference image (image-to-video). http(s) URL, codelf-artifact:// URL, absolute path, or workspace-relative path.'),
  lastFrame: z.string().optional().describe('Optional last-frame reference image (first+last frame interpolation).'),
  referenceImages: z.array(z.string().min(1)).optional().describe('Optional additional reference image(s) for style/subject guidance.'),
  resolution: z.string().optional().describe('Resolution: "480p", "720p", or "1080p". Defaults to configured value.'),
  duration: z.number().int().min(1).max(30).optional().describe('Video length in seconds. Defaults to configured value.'),
  ratio: z.string().optional().describe('Aspect ratio like "16:9", "9:16", "1:1". Defaults to configured value.'),
  generateAudio: z.boolean().optional().describe('Set true to also generate audio (model-dependent, usually costs more).'),
  outputPath: z.string().min(1).describe('REQUIRED. Full output file path INCLUDING the file name and a video extension (.mp4/.webm/.mov), e.g. "videos/shot-01.mp4" or "D:/clips/intro.mp4". Absolute or workspace-relative. A directory-only path is NOT accepted — you must specify the file name. This is where the finished video is saved, so choose a meaningful, unique name (for multi-shot videos use names like shot-01.mp4, shot-02.mp4).')
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

    // outputPath 现在必填，且必须是带文件名+视频扩展名的完整路径（不接受纯目录）。
    const raw = input.outputPath.trim()
    if (!raw) {
      emit('outputPath 不能为空。', 'error')
      return { content: 'outputPath 必填：请提供包含文件名和视频扩展名（.mp4/.webm/.mov）的完整路径，例如 "videos/shot-01.mp4"。', isError: true }
    }
    if (/[\\/]$/.test(raw) || !VIDEO_OUTPUT_EXTS.has(extname(raw).toLowerCase())) {
      emit('outputPath 必须包含文件名和视频扩展名。', 'error')
      return { content: `outputPath 必须是完整的文件路径，包含文件名和视频扩展名（.mp4/.webm/.mov），不能只给目录。当前值："${raw}"。请改成形如 "videos/shot-01.mp4" 的路径。`, isError: true }
    }
    let resolvedOutputPath: string
    if (isAbsolute(raw)) {
      resolvedOutputPath = raw
    } else if (ctx.workspaceRoot) {
      resolvedOutputPath = resolvePath(ctx.workspaceRoot, raw)
    } else {
      emit('outputPath 是相对路径但当前没有工作区根。', 'error')
      return { content: 'outputPath 是相对路径，但当前没有打开工作区，无法解析。请改用绝对路径（包含文件名）。', isError: true }
    }

    const task = enqueueVideoTask({
      prompt: input.prompt,
      sessionId: ctx.sessionId,
      resolution: input.resolution || settings.resolution,
      ratio: input.ratio || settings.ratio,
      duration: input.duration && input.duration > 0 ? input.duration : settings.duration,
      generateAudio: input.generateAudio ?? settings.generateAudio,
      outputPath: resolvedOutputPath,
      req: {
        prompt: input.prompt,
        firstFrame: input.firstFrame,
        lastFrame: input.lastFrame,
        referenceImages: input.referenceImages,
        resolution: input.resolution,
        duration: input.duration,
        ratio: input.ratio,
        generateAudio: input.generateAudio,
        workspaceRoot: ctx.workspaceRoot,
        outputPath: resolvedOutputPath
      }
    })

    emit('已加入视频生成队列，正在后台生成…', 'completed')
    return {
      content: `视频生成任务已加入后台队列（任务 ID: ${task.id}）。生成完成后视频会保存为：${resolvedOutputPath}（文件名：${basename(resolvedOutputPath)}）。\n\n视频生成较慢，会在后台继续生成，进度和结果会显示在右侧「产物预览 → 视频队列」面板中，不影响当前对话。无需重复提交。\n\n若你后续需要使用这个视频文件（例如拼接多镜头、读取路径），请用 GetVideoTask 工具传入上面的任务 ID 轮询，直到 status 为 succeeded 后从 filePath 取得最终落盘路径。`
    }
  }
}
