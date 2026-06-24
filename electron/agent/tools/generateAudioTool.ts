import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { generateSpeech } from '../services/audioGenService'
import { GENERATE_SPEECH_NAME, GENERATE_SPEECH_DESCRIPTION } from '../prompts/tools/audioGen'

const generateSpeechSchema = z.object({
  text: z.string().min(1).describe('The text to synthesize into speech'),
  voice: z.string().optional().describe('Preset voice id (voice_type), e.g. "zh_female_qingxin". Defaults to configured.'),
  speed: z.number().min(0.5).max(2).optional().describe('Speech rate 0.5-2.0 (1.0 = normal). Defaults to configured.'),
  format: z.enum(['mp3', 'wav', 'ogg_opus', 'pcm']).optional().describe('Output audio format. Defaults to configured.')
})

type GenerateSpeechInput = z.infer<typeof generateSpeechSchema>

export const generateAudioTool: Tool<GenerateSpeechInput> = {
  name: GENERATE_SPEECH_NAME,
  description: GENERATE_SPEECH_DESCRIPTION,
  schema: generateSpeechSchema,
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

    emit('正在调用语音端点合成中…', 'running')
    const outcome = await generateSpeech(
      { text: input.text, voice: input.voice, speed: input.speed, encoding: input.format },
      { signal: ctx.signal }
    )
    if (!outcome.ok || !outcome.audio) {
      emit(outcome.error ?? '语音合成失败。', 'error')
      return { content: outcome.error ?? '语音合成失败。', isError: true }
    }
    emit('语音合成完成', 'completed')
    return {
      content: `已合成语音并在界面中展示给用户播放（对话框内置播放条）。无需在回复里重复粘贴音频 URL（URL 很长且易出错）。\n\n![audio](${outcome.audio.url})`
    }
  }
}
