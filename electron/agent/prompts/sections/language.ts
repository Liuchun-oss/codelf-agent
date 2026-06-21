import type { PromptContext } from '../types'


export function getLanguageSection(ctx: PromptContext): string {
  return `# Language
Always respond to the user in ${ctx.responseLanguage}. Keep code, identifiers, file paths, and commands in their original form.`
}


export function getEnvSection(ctx: PromptContext): string {
  const lines = [
    '# Environment',
    `OS: ${ctx.os}`,
    `Shell: ${ctx.shell}`
  ]
  if (ctx.workspacePath) lines.push(`Workspace: ${ctx.workspacePath}`)
  else lines.push('Workspace: (none open)')
  return lines.join('\n')
}
