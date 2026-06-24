import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { getVideoTask } from '../../services/videoTaskQueue'
import { GET_VIDEO_TASK_NAME, GET_VIDEO_TASK_DESCRIPTION } from '../prompts/tools/videoGen'

const getVideoTaskSchema = z.object({
  taskId: z.string().min(1).describe('The video task ID returned by GenerateVideo (e.g. "vtask-...").')
})

type GetVideoTaskInput = z.infer<typeof getVideoTaskSchema>

export const getVideoTaskTool: Tool<GetVideoTaskInput> = {
  name: GET_VIDEO_TASK_NAME,
  description: GET_VIDEO_TASK_DESCRIPTION,
  schema: getVideoTaskSchema,
  readOnly: true,
  concurrencySafe: true,
  deferred: true,
  async execute(input): Promise<ToolResult> {
    const task = getVideoTask(input.taskId)
    if (!task) {
      return { content: `未找到任务 ${input.taskId}。请确认任务 ID 是否正确（GenerateVideo 返回的 vtask-... 形式）。`, isError: true }
    }

    const lines: string[] = [
      `任务 ID: ${task.id}`,
      `状态: ${task.status}`
    ]
    if (task.progress) lines.push(`进度: ${task.progress}`)
    if (task.status === 'succeeded') {
      lines.push(`最终文件路径(filePath): ${task.filePath ?? '(未知)'}`)
      lines.push(`预览 URL: ${task.videoUrl ?? '(未知)'}`)
      lines.push('视频已落盘，可直接使用 filePath 做后续处理（如读取、拼接多镜头）。')
    } else if (task.status === 'failed') {
      lines.push(`错误: ${task.error ?? '未知错误'}`)
    } else if (task.status === 'cancelled') {
      lines.push('任务已被取消。')
    } else {
      lines.push('任务仍在进行中。请稍后（建议间隔数秒，可配合 sleep）再次调用本工具轮询，直到 status 变为 succeeded 或 failed。不要重复提交新的生成任务。')
    }

    const isError = task.status === 'failed'
    return { content: lines.join('\n'), isError }
  }
}
