import type { ChatMessage } from '../providers'
import type { ToolRegistry } from './registry'
import { SEARCH_EXTRA_TOOLS_NAME } from './deferredTools'

const DISCOVERY_BULLET_PATTERN = /^-\s+([^\s(]+)\s+\(/gm
const LEGACY_FOUND_PATTERN = /^Found \d+ deferred tool\(s\):\s+(.+)\.$/m

export function extractDeferredToolNamesFromSearchResult(content: string): string[] {
  const names = new Set<string>()
  for (const match of content.matchAll(DISCOVERY_BULLET_PATTERN)) {
    const name = match[1]?.trim()
    if (name) names.add(name)
  }

  const legacy = LEGACY_FOUND_PATTERN.exec(content)
  if (legacy?.[1]) {
    for (const name of legacy[1].split(',')) {
      const trimmed = name.trim()
      if (trimmed) names.add(trimmed)
    }
  }

  return [...names]
}

export function extractDiscoveredDeferredToolNames(messages: readonly ChatMessage[]): string[] {
  const names = new Set<string>()
  const toolCallNames = new Map<string, string>()

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) toolCallNames.set(call.id, call.name)
      continue
    }
    if (message.role !== 'tool' || !message.toolCallId) continue
    if (toolCallNames.get(message.toolCallId) !== SEARCH_EXTRA_TOOLS_NAME) continue
    for (const name of extractDeferredToolNamesFromSearchResult(message.content)) names.add(name)
  }

  return [...names]
}

export function restoreDeferredToolDiscovery(registry: ToolRegistry, messages: readonly ChatMessage[], persistedNames?: readonly string[]): void {
  const names = new Set<string>(persistedNames ?? [])
  for (const name of extractDiscoveredDeferredToolNames(messages)) names.add(name)
  registry.restoreDiscoveredDeferredTools([...names])
}

/**
 * 延迟工具公告块。
 *
 * 关键约束：该块拼接在 system 之后、本轮消息之前，属于提示词缓存前缀的一部分。
 * 因此它必须在整个会话内「逐字节恒定」，否则模型每发现一个延迟工具就会改写本块，
 * 导致 DeepSeek/OpenAI 的前缀缓存从这里整段失效（实测命中率会从 ~98% 跌到 ~17%）。
 *
 * 为此，本块只列出全部延迟工具的 name + 简述（按名排序、措辞固定），
 * 不再区分「已发现/未发现」，也不再内联 schema。
 *
 * 简述 = description 的首个段落（首个空行 \n\n 之前），通常是一句自包含的用途说明，
 * 足以让模型判断「要不要 SearchExtraTools 把它调出来」。完整 description（含 Behavior/
 * 用法细节）与 schema 由 SearchExtraTools 的返回提供——那部分写进对话历史、只增不改，
 * 不会破坏前缀缓存。发现门控仍由 ExecuteExtraTool 自身校验（见 deferredTools.ts）。
 */
export function buildDeferredToolsAnnouncement(registry: ToolRegistry): string | null {
  const all = registry.listDeferredToolSummaries()
  if (all.length === 0) return null

  const out: string[] = [
    '<available-deferred-tools>',
    'These tools are available but NOT listed in the tools schema (kept out by design to preserve the prompt-cache prefix). Each line is a short summary; call SearchExtraTools with query="select:ToolName" to load its full description and schema, then run it via ExecuteExtraTool ({"name":"<tool>","arguments":{...}}). Do not call them directly before discovery.'
  ]
  for (const tool of [...all].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(`- ${tool.name}: ${summarizeDeferredDescription(tool.description)}`)
  }
  out.push('</available-deferred-tools>')
  return out.join('\n')
}

/**
 * 取 description 的首个段落作为简述：截到第一个空行（\n\n）之前，
 * 再把段内换行压成空格、折叠多余空白。多数延迟工具的首段就是一句完整的用途说明。
 */
function summarizeDeferredDescription(description: string): string {
  const trimmed = description.trim()
  const firstParaEnd = trimmed.search(/\n\s*\n/)
  const firstPara = firstParaEnd >= 0 ? trimmed.slice(0, firstParaEnd) : trimmed
  return firstPara.replace(/\s+/g, ' ').trim()
}
