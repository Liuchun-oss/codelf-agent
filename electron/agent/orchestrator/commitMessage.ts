import { createAdapter, type ChatMessage } from '../providers'
import { getProfileRaw, getActiveProfileId, getActiveProfileApiKey } from '../providers/profileStore'
import type { GitGenerateMessageResult } from '@shared/gitTypes'

const SYSTEM_PROMPT = `你是一个生成 Git 提交信息的助手。根据用户提供的已暂存 diff，生成一条简洁、规范的提交信息。

要求：
- 使用约定式提交（Conventional Commits）风格：<type>(<scope>): <subject>，type 取自 feat/fix/docs/style/refactor/perf/test/chore/build 等。
- 第一行（标题）不超过 50 个字符，使用中文描述主题。
- 如有必要，空一行后补充正文，说明改动动机与影响，每行不超过 72 字符。
- 只输出提交信息本身，不要包含反引号、解释或额外说明。`

export async function generateCommitMessage(diff: string): Promise<GitGenerateMessageResult> {
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

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `请为以下已暂存的改动生成提交信息：\n\n${diff}` }
  ]

  try {
    let text = ''
    const gen = adapter.streamChat({
      model: profile.model,
      messages,
      maxOutputTokens: 400,
      temperature: 0.3
    })
    for await (const chunk of gen) {
      if (chunk.type === 'text') text += chunk.text
    }
    const message = cleanup(text)
    if (!message) return { ok: false, error: '模型未返回有效内容' }
    return { ok: true, message }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '生成失败' }
  }
}

function cleanup(text: string): string {
  let t = text.trim()
  
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t)
  if (fence) t = fence[1].trim()
  return t
}
