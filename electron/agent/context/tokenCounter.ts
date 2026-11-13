import {
  get_encoding,
  get_encoding_name_for_model,
  type Tiktoken,
  type TiktokenEncoding
} from 'tiktoken'
import type { ProviderKind } from '@shared/agentTypes'
import { countDeepSeekTokens, truncateDeepSeekTokens, isDeepSeekModel } from './deepseekTokenizer'


export const DEFAULT_ATTACHMENT_TOKEN_BUDGET = 4000

const ENCODING_CACHE = new Map<TiktokenEncoding, Tiktoken>()


export function estimateTokensChar(text: string): number {
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x4e00 && code <= 0x9fff) cjk++
  }
  const others = [...text].length - cjk
  return Math.ceil(cjk * 1.5 + others / 4)
}


export function resolveEncodingName(model: string, kind?: ProviderKind): TiktokenEncoding {
  const m = model.trim().toLowerCase()
  if (!m) return 'cl100k_base'
  if (kind === 'anthropic' || m.includes('claude')) return 'cl100k_base'
  if (m.includes('deepseek') || m.includes('qwen') || m.includes('glm')) return 'cl100k_base'
  try {
    return get_encoding_name_for_model(m as Parameters<typeof get_encoding_name_for_model>[0])
  } catch {
    if (m.startsWith('gpt-4o') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) {
      return 'o200k_base'
    }
    return 'cl100k_base'
  }
}

function getEncoding(encodingName: TiktokenEncoding): Tiktoken {
  let enc = ENCODING_CACHE.get(encodingName)
  if (!enc) {
    enc = get_encoding(encodingName)
    ENCODING_CACHE.set(encodingName, enc)
  }
  return enc
}


export function countTokens(text: string, model?: string, kind?: ProviderKind): number {
  if (!text) return 0
  if (isDeepSeekModel(model, kind)) {
    const exact = countDeepSeekTokens(text)
    if (exact !== null) return exact
  }
  try {
    const enc = getEncoding(resolveEncodingName(model ?? 'gpt-4o', kind))
    return enc.encode(text).length
  } catch {
    return estimateTokensChar(text)
  }
}


export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
  model?: string,
  kind?: ProviderKind
): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text.length > 0 }
  if (!text) return { text: '', truncated: false }
  if (isDeepSeekModel(model, kind)) {
    const exact = truncateDeepSeekTokens(text, maxTokens)
    if (exact !== null) return exact
  }
  try {
    const enc = getEncoding(resolveEncodingName(model ?? 'gpt-4o', kind))
    const tokens = enc.encode(text)
    if (tokens.length <= maxTokens) return { text, truncated: false }
    const slice = tokens.slice(0, maxTokens)
    return { text: new TextDecoder().decode(enc.decode(slice) as Uint8Array), truncated: true }
  } catch {
    const approxChars = maxTokens * 4
    if (text.length <= approxChars) return { text, truncated: false }
    return { text: text.slice(0, approxChars), truncated: true }
  }
}


export function countChatMessagesTokens(
  messages: Array<{ role: string; content: string }>,
  model: string,
  kind?: ProviderKind
): number {
  let total = 3
  for (const m of messages) {
    total += countTokens(m.content, model, kind)
    total += 4
  }
  return total
}

export interface CountableChatMessage {
  role: string
  content: string
  toolCalls?: Array<{ name: string; arguments?: string }>
}

// 与 countChatMessagesTokens 的区别：assistant 消息里的工具调用（名称 + JSON 参数）
// 也计入。write_file / edit_file 这类调用的参数本身就有几 KB~几十 KB，之前完全没进
// 统计，是「本地算着没超、服务端已经超」的来源之一。
export function countChatMessagesTokensFull(
  messages: CountableChatMessage[],
  model: string,
  kind?: ProviderKind
): number {
  let total = 3
  for (const m of messages) {
    total += countTokens(m.content, model, kind) + 4
    if (m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        total += countTokens(tc.name, model, kind) + countTokens(tc.arguments ?? '', model, kind) + 8
      }
    }
  }
  return total
}


export function freeTokenEncodersForTests(): void {
  for (const enc of ENCODING_CACHE.values()) enc.free()
  ENCODING_CACHE.clear()
}
