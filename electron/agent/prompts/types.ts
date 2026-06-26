

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
  
  /** 是否运行在子 Agent 上下文中。主 Agent 不设或为 false。 */
  isSubagent?: boolean

  /**
   * 微信 agent 人格定义（出厂设置）。仅微信会话的轮次会带上，
   * 桌面端 UI 的 Agent 不带 → 实现「仅微信 agent」的人格隔离。
   * 已激活时为人格正文；处于首次激活引导时为特殊标记。
   */
  persona?: {
    /** 引导模式：尚未激活，需要主动问用户收集人格信息。 */
    activationMode?: boolean
    /** 已激活的人格正文（activationMode 为 false 时有效）。 */
    selfName?: string
    ownerName?: string
    addressing?: string
    style?: string
  }
}


export interface SystemPromptParts {
  systemPrompt: string[]
}


export function prependBullets(items: Array<string | string[]>): string[] {
  return items.flatMap((it) =>
    Array.isArray(it) ? it.map((s) => `  - ${s}`) : [` - ${it}`]
  )
}
