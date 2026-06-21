

export interface PromptContext {
  appName: string
  os: string
  
  date: string
  
  shell: string
  
  responseLanguage: string
  workspacePath?: string
  activeFilePath?: string
  model?: string
  
  enabledTools: string[]
  
  permissionMode?: 'default' | 'acceptEdits'
}


export interface SystemPromptParts {
  systemPrompt: string[]
}


export function prependBullets(items: Array<string | string[]>): string[] {
  return items.flatMap((it) =>
    Array.isArray(it) ? it.map((s) => `  - ${s}`) : [` - ${it}`]
  )
}
