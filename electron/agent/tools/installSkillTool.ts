import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { installSkillFromSource } from '../skills/installSkill'
import { APP_NAME, DATA_DIR_NAME } from '@shared/appConfig'

export const INSTALL_SKILL_TOOL_NAME = 'InstallSkill'

const installSkillSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe('Skill source: GitHub shorthand (owner/repo), full GitHub URL, a /tree/ URL pointing at a skill subdirectory, or any git URL'),
  skills: z
    .array(z.string())
    .optional()
    .describe('Specific skill names to install. Use ["*"] or omit to install all skills found in the source'),
  listOnly: z
    .boolean()
    .optional()
    .describe('Only discover and list available skills in the source without installing')
})

type InstallSkillInput = z.infer<typeof installSkillSchema>

export const installSkillTool: Tool<InstallSkillInput> = {
  name: INSTALL_SKILL_TOOL_NAME,
  description:
    `Discover, download, adapt, and install agent skills from a remote source into the user skills directory (~/${DATA_DIR_NAME}/skills). Accepts skills.sh-style sources including owner/repo, owner/repo@skill-name (installs just that one skill), full GitHub URLs, /tree/ URLs to a subdirectory, and git URLs. Automatically discovers SKILL.md files in common layouts including catalog directories (e.g. skills/.curated/<name>/). Rewrites tool names to ${APP_NAME} conventions (Read→read_file, Bash→run_terminal_cmd), normalizes frontmatter, copies bundled scripts/files, and installs the skills. Use listOnly:true first to see what a source contains. Requires git on the machine.`,
  schema: installSkillSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const result = await installSkillFromSource({
        source: input.source,
        skillNames: input.skills,
        listOnly: input.listOnly,
        signal: ctx.signal
      })

      const lines: string[] = []
      lines.push(`Source: ${result.source.label} (${result.source.gitUrl})`)
      if (result.source.subdir) lines.push(`Subdirectory: ${result.source.subdir}`)
      lines.push(`Discovered skills: ${result.available.length > 0 ? result.available.join(', ') : '(none)'}`)

      if (input.listOnly) {
        lines.push('', 'List-only mode: nothing was installed. Call again without listOnly to install.')
        return { content: lines.join('\n'), isError: result.available.length === 0 }
      }

      if (result.installed.length > 0) {
        lines.push('', `Installed ${result.installed.length} skill(s) to ~/${DATA_DIR_NAME}/skills:`)
        for (const skill of result.installed) {
          lines.push(`- ${skill.name} → ${skill.targetDir}`)
          lines.push(`  files: ${skill.files.join(', ')}`)
          for (const note of skill.notes) lines.push(`  note: ${note}`)
        }
        lines.push('', 'These skills are now available. They will appear in the Available skills list on the next turn; invoke one with the Skill tool by its name.')
      } else {
        lines.push('', 'No skills were installed.')
      }

      if (result.errors.length > 0) {
        lines.push('', 'Errors:')
        for (const err of result.errors) lines.push(`- ${err}`)
      }

      return { content: lines.join('\n'), isError: result.installed.length === 0 && !input.listOnly }
    } catch (e) {
      return { content: `安装 skill 失败: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  }
}
