

import type { RoomContext } from '@shared/roomTypes'

export interface PromptContext {
  appName: string
  os: string
  
  date: string
  
  shell: string
  
  responseLanguage: string
  workspacePath?: string
  /** 记忆读写专用工作区根（worktree 隔离时 = 基础路径，与 workspacePath 解耦）。不设则用 workspacePath。 */
  memoryWorkspacePath?: string
  activeFilePath?: string
  model?: string
  
  enabledTools: string[]
  
  permissionMode?: 'default' | 'acceptEdits'

  /**
   * 越狱模式是否开启。开启后工具调用一律放行（含 deny 规则）、
   * 允许访问工作区外路径、PreToolUse hook 的 deny 被反写为放行。
   */
  jailbreak?: boolean

  /**
   * 红队指挥官模式。开启后向主 Agent 追加指挥官提示词（详见 sections/redteam.ts）。
   * 子 Agent 不设此项 —— 它们用自己的角色提示词。
   */
  redteamCommander?: boolean

  /**
   * 越狱模式下的自定义系统提示词正文。非空时整体替换内置系统提示词，
   * 只保留该正文（与群聊岗位的 rawSystemPrompt 同机制，但作用于全部入口）。
   * 仅当设置里开启越狱模式、且填了正文时才会被填入。
   */
  jailbreakSystemPrompt?: string
  
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

  /**
   * 群聊岗位上下文。仅群聊岗位会话的轮次会带上，驱动「岗位身份段 + 群上下文段」
   * （getRoomSeatSection）。桌面/微信会话不带 → 群聊提示词只作用于岗位，不污染其它入口。
   * 与 persona 互斥：岗位会话用 roomContext，微信会话用 persona。
   */
  roomContext?: RoomContext

  /**
   * 通讯通道上下文。仅经由 IM 通道（如微信）转发进来的轮次会带上，
   * 桌面端 UI 的 Agent 不带 → 让 agent 知道「自己正在被远程用户通过 IM 聊天」。
   * 驱动 getChannelSection：注入场景感知（用户大概率不在电脑旁、回复要适配手机阅读）
   * 与「如何把文件发给用户」的约定（无需工具，按约定格式输出即可）。
   */
  channel?: {
    /** 通道标识，如 'weixin'。 */
    id: string
    /** 面向用户的展示名，如 '微信'。 */
    label: string
    /** 该通道是否支持把文件发回给用户（决定是否注入发文件说明）。 */
    canSendFile?: boolean
    /** 该通道是否支持把图片/截图发回给用户（决定是否注入发截图说明）。 */
    canSendImage?: boolean
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
