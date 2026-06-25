import type { PromptContext } from '../types'
import { listAgentDefinitions, summarizeAgentDefinition } from '../../orchestrator/agentDefinitions'
import type { AgentDefinitionSummary } from '@shared/agentTypes'

export interface SubagentContextSnapshot {
  projectAgents: AgentDefinitionSummary[]
}

export function collectSubagentContext(ctx: PromptContext): SubagentContextSnapshot {
  try {
    const all = listAgentDefinitions(ctx.workspacePath).map(summarizeAgentDefinition)
    return { projectAgents: all.filter((a) => a.source === 'project') }
  } catch {
    return { projectAgents: [] }
  }
}

export function renderSubagentContext(snap: SubagentContextSnapshot): string | null {
  if (snap.projectAgents.length === 0) return null
  const lines = snap.projectAgents.map((a) => {
    const flags = [a.readOnly ? 'read-only' : 'write-capable', a.model ? `model=${a.model}` : null]
      .filter(Boolean)
      .join(', ')
    const title = a.title && a.title !== a.id ? ` (${a.title})` : ''
    return `- \`${a.id}\`${title}: ${a.description} [${flags}]`
  })
  return [
    '# Project sub-agents',
    '',
    'These project-defined sub-agents are available in addition to the built-in types. Pass the id as run_subagent\'s subagentType when the task matches one; otherwise use a built-in type.',
    '',
    ...lines
  ].join('\n')
}
