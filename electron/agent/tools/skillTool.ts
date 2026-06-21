import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { findSkill, formatSkillForInvocation, loadAvailableSkills, summarizeSkill } from '../skills/loadSkills'
import { getAgentDefinition, type AgentDefinition } from '../orchestrator/agentDefinitions'
import { APP_NAME } from '@shared/appConfig'

export const SKILL_TOOL_NAME = 'Skill'

const skillSchema = z.object({
  name: z.string().min(1).describe('Exact skill name from the Available skills system prompt section'),
  args: z.string().optional().describe('Optional arguments or task-specific context to pass to the skill'),
  runInBackground: z.boolean().optional().describe('For context=fork skills, start the sub-agent asynchronously and return immediately'),
  forkContext: z.boolean().optional().describe('For context=fork skills, include a compact snapshot of the parent conversation context. Defaults to true.'),
  isolatedWorktree: z.boolean().optional().describe('For context=fork skills, run against a detached temporary Git worktree')
})

type SkillInput = z.infer<typeof skillSchema>

function formatAvailableSkillNames(skills: Awaited<ReturnType<typeof loadAvailableSkills>>): string {
  if (skills.length === 0) return '(no skills found)'
  return skills.map((skill) => `- ${skill.name} [${skill.source}]: ${skill.description}`).join('\n')
}

function uniqueToolNames(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

function skillAgentDefinition(skill: Awaited<ReturnType<typeof findSkill>>, workspaceRoot: string | null): AgentDefinition | undefined {
  if (!skill || skill.context !== 'fork') return undefined
  const base = getAgentDefinition(skill.subagentType ?? 'general-purpose', workspaceRoot)
  const allowedTools = uniqueToolNames(skill.allowedTools)
  if (allowedTools.length === 0) return base
  return {
    ...base,
    id: `${base.id}+skill:${skill.name}`,
    title: `${base.title} (${skill.name})`,
    description: `${base.description} Tool access constrained by skill ${skill.name}.`,
    allowedTools,
    deniedTools: uniqueToolNames([...base.deniedTools, 'run_subagent'])
  }
}

export const skillTool: Tool<SkillInput> = {
  name: SKILL_TOOL_NAME,
  description: `Load and invoke a reusable ${APP_NAME} skill. IMPORTANT: Only call this tool when the user explicitly asks to use a specific skill, or when the "Available skills" section in the system prompt lists a skill whose description directly matches the user's task. Do NOT call this for basic conversation, greetings, or when no matching skill exists. Pass the exact skill name in name and any user arguments in args.`,
  schema: skillSchema,
  readOnly: true,
  concurrencySafe: false,
  alwaysLoad: true,
  async execute(input, ctx): Promise<ToolResult> {
    const skill = await findSkill(ctx.workspaceRoot, input.name)
    if (!skill) {
      const skills = await loadAvailableSkills(ctx.workspaceRoot)
      return {
        content: [
          `Skill not found: ${input.name}`,
          'Available skills:',
          formatAvailableSkillNames(skills)
        ].join('\n'),
        isError: true
      }
    }

    const summary = summarizeSkill(skill)
    const header = [
      `Loaded skill: ${summary.name}`,
      summary.displayName ? `Display name: ${summary.displayName}` : null,
      `Source: ${summary.source}`,
      `Description: ${summary.description}`,
      summary.whenToUse ? `When to use: ${summary.whenToUse}` : null,
      summary.version ? `Version: ${summary.version}` : null,
      summary.allowedTools.length > 0 ? `Allowed tools: ${summary.allowedTools.join(', ')}` : null,
      summary.context === 'fork'
        ? `Note: this skill runs in an isolated sub-agent${summary.subagentType ? ` of type ${summary.subagentType}` : ''}${summary.allowedTools.length > 0 ? ' with an enforced tool whitelist' : ''}.`
        : null
    ].filter(Boolean).join('\n')

    const invocation = formatSkillForInvocation(skill, input.args)

    if (skill.context === 'fork') {
      const { createRunSubagentTool } = await import('../orchestrator/subagent')
      const subagentTool = createRunSubagentTool({
        resolveAgentDefinition: (_input, workspaceRoot) => skillAgentDefinition(skill, workspaceRoot)
      })
      const result = await subagentTool.execute({
        description: `Skill: ${skill.name}`,
        task: invocation,
        subagentType: skill.subagentType ?? 'general-purpose',
        expectedOutput: '返回该 skill 工作流的最终结论、关键证据、执行过的验证步骤，以及需要父 Agent 继续处理的事项。',
        runInBackground: input.runInBackground,
        forkContext: input.forkContext ?? true,
        isolatedWorktree: input.isolatedWorktree
      }, ctx)

      return {
        ...result,
        content: `${header}\nExecution context: fork sub-agent\n\n${result.content}`
      }
    }

    return {
      content: `${header}\n\n${invocation}`,
      truncated: skill.body.includes('…(skill body truncated')
    }
  }
}
