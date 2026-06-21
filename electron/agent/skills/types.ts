export type SkillExecutionContext = 'inline' | 'fork'

export type SkillSource = 'user' | 'project'

export interface SkillDefinition {
  
  name: string
  
  displayName?: string
  description: string
  whenToUse?: string
  allowedTools: string[]
  
  paths?: string[]
  context: SkillExecutionContext
  
  subagentType?: string
  model?: string
  version?: string
  source: SkillSource
  
  dir: string
  
  filePath: string
  
  body: string
}

export interface SkillSummary {
  name: string
  displayName?: string
  description: string
  whenToUse?: string
  allowedTools: string[]
  paths?: string[]
  context: SkillExecutionContext
  subagentType?: string
  source: SkillSource
  version?: string
}
