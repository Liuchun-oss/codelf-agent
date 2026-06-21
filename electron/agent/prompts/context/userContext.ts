import { promises as fs } from 'fs'
import { join } from 'path'
import type { PromptContext } from '../types'
import {
  loadProjectRules,
  pickApplicableRules,
  ruleActivation,
  type AgentRule
} from '../../context/rules'



const AGENTS_MD_MAX_BYTES = 32 * 1024

export interface UserContextSnapshot {
  agentsMd?: string
  rules: AgentRule[]
  
  applicable: AgentRule[]
  
  agentRequested: AgentRule[]
}

export async function collectUserContext(ctx: PromptContext): Promise<UserContextSnapshot> {
  const [agentsMd, rules] = await Promise.all([
    readAgentsMd(ctx.workspacePath),
    loadProjectRules(ctx.workspacePath)
  ])
  // 仅 alwaysApply 规则进入 system。基于活动文件的 glob 命中已移除：活动文件不再
  // 参与上下文，避免“切换文件”这种高频操作改动提示词。带 glob 的规则改由模型在
  // agentRequested 清单中按相关性自行请求。
  const applicable = pickApplicableRules(rules, {})
  const applicableNames = new Set(applicable.map((r) => r.name))
  const agentRequested = rules.filter(
    (r) => ruleActivation(r) === 'agentRequested' && !applicableNames.has(r.name)
  )
  return { agentsMd, rules, applicable, agentRequested }
}

export function renderUserContext(snap: UserContextSnapshot): string | null {
  const sections: string[] = []
  if (snap.agentsMd) {
    sections.push('## AGENTS.md\n\n' + snap.agentsMd.trim())
  }
  if (snap.applicable.length > 0) {
    const blocks = snap.applicable.map((r) => `### Rule: ${r.name} (always)\n\n${r.body}`)
    sections.push('## Project rules\n\n' + blocks.join('\n\n'))
  }
  if (snap.agentRequested.length > 0) {
    const lines = snap.agentRequested.map(
      (r) => `- ${r.name}: ${r.description?.trim() || '(no description)'}`
    )
    sections.push(
      '## Available rules (request by relevance)\n\n' +
        'The following project rules are available. If one is relevant to the task, follow it; ' +
        'the user can also attach its full text with @' +
        '<rule-name>.\n\n' +
        lines.join('\n')
    )
  }
  if (sections.length === 0) return null
  return ['# Project instructions', '', ...sections].join('\n')
}

async function readAgentsMd(workspaceRoot: string | undefined): Promise<string | undefined> {
  if (!workspaceRoot) return undefined
  const candidates = [join(workspaceRoot, 'AGENTS.md'), join(workspaceRoot, 'agents.md')]
  for (const p of candidates) {
    try {
      const stat = await fs.stat(p)
      if (!stat.isFile()) continue
      if (stat.size > AGENTS_MD_MAX_BYTES) {
        const buf = await fs.readFile(p)
        return (
          buf.subarray(0, AGENTS_MD_MAX_BYTES).toString('utf8') +
          `\n…(truncated, ${stat.size - AGENTS_MD_MAX_BYTES} more bytes)`
        )
      }
      return await fs.readFile(p, 'utf8')
    } catch {
      
    }
  }
  return undefined
}
