import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { AgentDefinitionSummary } from '@shared/agentTypes'
import { DATA_DIR_NAME } from '@shared/appConfig'

export type AgentDefinitionSource = 'built-in' | 'project'

export interface AgentDefinition {
  id: string
  title: string
  description: string
  source: AgentDefinitionSource
  readOnly: boolean
  prompt: string
  allowedTools?: string[]
  deniedTools: string[]
  path?: string
  /** 该项目级 agent 默认绑定的模型（Provider 配置 id / 名称 / 模型名）。调用时显式传入的 model 优先级更高。 */
  model?: string
}

const NO_RECURSIVE_SUBAGENT = ['run_subagent']

export const BUILT_IN_AGENT_DEFINITIONS: Record<string, AgentDefinition> = {
  readonly: {
    id: 'readonly',
    title: 'Read-only sub-agent',
    description: 'Default isolated sub-agent for read-only investigation and concise reporting.',
    source: 'built-in',
    readOnly: true,
    prompt: '你是默认只读子 Agent。重点是调查、验证和总结，不要修改文件。',
    deniedTools: NO_RECURSIVE_SUBAGENT
  },
  explore: {
    id: 'explore',
    title: 'Explore sub-agent',
    description: 'Fast codebase exploration sub-agent for locating files, symbols, flows, and evidence.',
    source: 'built-in',
    readOnly: true,
    prompt: '你是代码库探索子 Agent。优先快速定位相关文件、符号、调用链和证据，最终输出路径、关键发现和不确定点。',
    allowedTools: ['read_file', 'list_dir', 'grep', 'codebase_search', 'search_history', 'web_fetch'],
    deniedTools: NO_RECURSIVE_SUBAGENT
  },
  reviewer: {
    id: 'reviewer',
    title: 'Reviewer sub-agent',
    description: 'Read-only review sub-agent for checking correctness, regressions, diagnostics, and risks.',
    source: 'built-in',
    readOnly: true,
    prompt: '你是代码审查子 Agent。重点检查正确性、回归风险、诊断结果和遗漏点；不要修改文件，只给出证据化结论。',
    allowedTools: ['read_file', 'list_dir', 'grep', 'codebase_search', 'get_diagnostics', 'search_history'],
    deniedTools: NO_RECURSIVE_SUBAGENT
  },
  'general-purpose': {
    id: 'general-purpose',
    title: 'General-purpose sub-agent',
    description: 'General read-only sub-agent for broader research, planning, and synthesis tasks.',
    source: 'built-in',
    readOnly: true,
    prompt: '你是通用子 Agent。可以进行较宽泛的只读研究、计划和综合分析；必要时先探索再归纳。',
    deniedTools: NO_RECURSIVE_SUBAGENT
  },
  implementer: {
    id: 'implementer',
    title: 'Implementer sub-agent',
    description: 'Write-capable sub-agent for well-scoped implementation tasks: creating/editing files and running commands within the workspace.',
    source: 'built-in',
    readOnly: false,
    prompt: '你是实现型子 Agent，具备写文件和执行命令的能力。请严格按任务范围落地代码：创建/修改文件、运行必要命令并自行验证；写入和终端操作仍受权限策略约束。完成后用简洁结构化的方式汇报改动的文件与验证结果。',
    deniedTools: NO_RECURSIVE_SUBAGENT
  },
  planner: {
    id: 'planner',
    title: 'Planner sub-agent',
    description: 'Read-only planning sub-agent that investigates the codebase and returns a structured plan document (策划书). Use it to keep heavy investigation out of the main conversation context.',
    source: 'built-in',
    readOnly: true,
    prompt: [
      '你是「策划师」子 Agent，专门产出结构化的策划书 / 实施计划。',
      '工作方式：先用只读工具（read_file / grep / codebase_search / list_dir）调研任务真正涉及的文件、函数、调用链和依赖，基于证据而非猜测来规划，调研范围只覆盖与任务相关的部分。',
      '最终只返回一份完整的中文策划书正文（Markdown），包含：目标与范围、关键现状与约束、方案概述、按顺序编号的具体步骤（每步标注涉及的文件/位置与验证方式）、风险与未决问题。',
      '不要修改任何文件，也不要输出与策划书无关的寒暄；你的正文会由主 Agent 落盘到 .codelf/plan/ 下并交用户评审。'
    ].join('\n'),
    deniedTools: NO_RECURSIVE_SUBAGENT
  }
}

interface ParsedAgentMarkdown {
  frontmatter: Record<string, string>
  body: string
}

function parseAgentMarkdown(raw: string): ParsedAgentMarkdown {
  if (!raw.startsWith('---')) return { frontmatter: {}, body: raw.trim() }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { frontmatter: {}, body: raw.trim() }
  const frontmatterText = raw.slice(3, end).trim()
  const body = raw.slice(end + '\n---'.length).trim()
  const frontmatter: Record<string, string> = {}
  for (const line of frontmatterText.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key) frontmatter[key] = value
  }
  return { frontmatter, body }
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const items = value.split(',').map((s) => s.trim()).filter(Boolean)
  return items.length > 0 ? items : undefined
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const v = value.trim().toLowerCase()
  if (v === 'true' || v === 'yes' || v === '1') return true
  if (v === 'false' || v === 'no' || v === '0') return false
  return undefined
}

function safeProjectAgentId(filename: string): string | null {
  const id = filename.replace(/\.md$/i, '').trim()
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null
}

export function loadProjectAgentDefinitions(workspaceRoot: string | null | undefined): AgentDefinition[] {
  if (!workspaceRoot) return []
  const dir = join(workspaceRoot, DATA_DIR_NAME, 'agents')
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))
  } catch {
    return []
  }

  const agents: AgentDefinition[] = []
  for (const file of files) {
    const id = safeProjectAgentId(file)
    if (!id) continue
    const path = join(dir, file)
    try {
      const { frontmatter, body } = parseAgentMarkdown(readFileSync(path, 'utf-8'))
      const prompt = body.trim()
      if (!prompt) continue
      const declaredReadOnly = parseBool(frontmatter.readOnly ?? frontmatter.readonly)
      agents.push({
        id,
        title: frontmatter.title || id,
        description: frontmatter.description || `Project sub-agent: ${id}`,
        source: 'project',
        readOnly: declaredReadOnly ?? true,
        prompt,
        deniedTools: [...NO_RECURSIVE_SUBAGENT, ...(splitList(frontmatter.deniedTools) ?? [])],
        path,
        model: frontmatter.model?.trim() || undefined
      })
    } catch {
      continue
    }
  }
  return agents
}

export function listAgentDefinitions(workspaceRoot?: string | null): AgentDefinition[] {
  const builtIns = Object.values(BUILT_IN_AGENT_DEFINITIONS)
  const projects = loadProjectAgentDefinitions(workspaceRoot)
  const byId = new Map<string, AgentDefinition>()
  for (const agent of builtIns) byId.set(agent.id, agent)
  for (const agent of projects) byId.set(agent.id, agent)
  return [...byId.values()]
}

export function getAgentDefinition(id?: string, workspaceRoot?: string | null): AgentDefinition {
  if (id) {
    const found = listAgentDefinitions(workspaceRoot).find((agent) => agent.id === id)
    if (found) return found
  }
  return BUILT_IN_AGENT_DEFINITIONS.readonly
}

export function summarizeAgentDefinition(agent: AgentDefinition): AgentDefinitionSummary {
  return {
    id: agent.id,
    title: agent.title,
    description: agent.description,
    source: agent.source,
    readOnly: agent.readOnly,
    allowedTools: agent.allowedTools,
    deniedTools: agent.deniedTools,
    path: agent.path,
    model: agent.model
  }
}
