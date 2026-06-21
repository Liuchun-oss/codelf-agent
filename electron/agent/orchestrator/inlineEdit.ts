import { createAdapter, type ChatMessage } from '../providers'
import { getProfileRaw, getActiveProfileId, getActiveProfileApiKey } from '../providers/profileStore'
import { isAbortError } from '../providers/base'
import type { InlineEditRequest, InlineEditResult } from '@shared/agentTypes'

const SYSTEM_PROMPT = `You are an inline code editing assistant inside an IDE. The user selected a region of code and gave an instruction to transform it.

Rules:
- Return ONLY the replacement code for the selected region. No explanations, no commentary.
- Do NOT wrap the output in markdown code fences.
- Preserve the original indentation style and surrounding conventions.
- Keep changes minimal and focused on the instruction.
- The surrounding context (before/after the selection) is provided only for reference; do NOT repeat it in your output.`

const MAX_CONTEXT_CHARS = 4000

export async function inlineEdit(
  req: InlineEditRequest,
  signal?: AbortSignal
): Promise<InlineEditResult> {
  const instruction = req.instruction?.trim()
  if (!instruction) return { ok: false, error: '请输入修改指令' }

  const profile = getProfileRaw(getActiveProfileId() ?? '')
  if (!profile) {
    return { ok: false, error: '未配置 AI Provider，请先在设置中添加并激活一个模型配置' }
  }
  const apiKey = getActiveProfileApiKey()

  let adapter: ReturnType<typeof createAdapter>
  try {
    adapter = createAdapter(profile, apiKey)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '无法创建 Provider' }
  }

  const prefix = (req.prefix ?? '').slice(-MAX_CONTEXT_CHARS)
  const suffix = (req.suffix ?? '').slice(0, MAX_CONTEXT_CHARS)
  const lang = req.language || 'plaintext'

  const userContent = [
    req.filePath ? `File: ${req.filePath}` : null,
    `Language: ${lang}`,
    '',
    prefix ? `Code before the selection:\n\`\`\`\n${prefix}\n\`\`\`` : null,
    `Selected code to transform:\n\`\`\`\n${req.selection}\n\`\`\``,
    suffix ? `Code after the selection:\n\`\`\`\n${suffix}\n\`\`\`` : null,
    '',
    `Instruction: ${instruction}`,
    '',
    'Output the replacement for the selected code only.'
  ]
    .filter((x): x is string => x !== null)
    .join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent }
  ]

  try {
    let text = ''
    const gen = adapter.streamChat(
      {
        model: profile.model,
        messages,
        temperature: 0.2
      },
      signal
    )
    for await (const chunk of gen) {
      if (chunk.type === 'text') text += chunk.text
    }
    const cleaned = stripFences(text)
    if (!cleaned.trim()) return { ok: false, error: '模型未返回有效内容' }
    return { ok: true, text: cleaned }
  } catch (e) {
    if (isAbortError(e)) return { ok: false, error: '已取消' }
    return { ok: false, error: e instanceof Error ? e.message : '生成失败' }
  }
}

function stripFences(text: string): string {
  let t = text.replace(/^\uFEFF/, '')
  
  const m = /^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/.exec(t)
  if (m) t = m[1]
  
  return t.replace(/\n+$/, '')
}
