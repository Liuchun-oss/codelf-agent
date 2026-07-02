// 多 Agent 群聊岗位系统（Team Room）共享类型。
// 主进程编排器、IPC、渲染进程 store 共用。设计见 docs/群聊岗位系统策划书.md。
//
// 关键边界（见策划书 §3.1）：群聊数据全部落 userData/codelf/rooms/，与
// .codelf/agents/ 的子 agent 物理隔离；岗位引擎是「标准主引擎」，绝不设
// isSubagent，改用 roomContext 驱动提示词差异化。

// 发言权调度策略。首版固定 host-routed（决策），其余留待阶段 4。
export type SpeakingPolicy = 'host-routed' | 'round-robin' | 'free'

// 岗位运行态（成员侧栏 + room_status 工具用）。
export type SeatState = 'idle' | 'working' | 'waiting-user' | 'paused' | 'error' | 'done'

/**
 * 岗位（Seat / Persona Agent）。= 人格定义 + 工作区 + 模型 + 工具权限 + 独立上下文。
 * 岗位定义直接内嵌在 room.json 的 seats[] 里（不用单独 md 文件）。
 */
export interface Seat {
  // 岗位唯一 id（同时是 seats/<id>/ 工作区目录名）。创建后只读（见 §11.7）。
  id: string
  // 显示名（@ 用）。
  name: string
  // 岗位/职位描述。
  role: string
  // emoji 或图片路径。
  avatar?: string
  // 是否主 Agent（群主）。
  isHost?: boolean
  // 仅主管有效：只负责调度、不亲自干活。开启后工具层强制禁掉写文件/改代码/跑命令等「动手」工具，
  // 只保留调度（mention_seat 等）+ 只读排查 + 记笔记。默认视为开启（undefined = 开启）。
  dispatchOnly?: boolean
  // 是否禁用 Codelf 内置系统提示词：开启后该岗位的 system prompt 只用下方人设（personaPrompt），
  // 不注入内置的身份/工作方式/群协作等段落。默认 false（用内置提示词）。给需要完全自定义人格的岗位用。
  rawSystemPrompt?: boolean
  // 绑定的模型 profile（复用现有 provider profile）。
  modelProfileId?: string
  // 工作区根：userData/codelf/rooms/<roomId>/seats/<id>。null = 纯对话岗位（不碰文件）。
  workspaceRoot: string | null
  readOnly: boolean
  // 白名单（JSON 原生数组，不受旧 md parser 限制）。
  allowedTools?: string[]
  // 黑名单。工人岗位默认含 'run_subagent'（host-only 决策）。
  deniedTools?: string[]
  // 人格说明书正文，注入 system prompt 动态段。
  personaPrompt: string
  // 是否在群里激活。
  enabled: boolean
  /**
   * 写冲突隔离（§9.2 进阶）：开启后，若该岗位 workspaceRoot 是一个 git 仓库，
   * 开工前自动为其建/进一个独立 git worktree（分支 codelf-worktree-room-<roomId>-seat-<id>），
   * 岗位在隔离副本里干活，互不踩踏。非 git 仓 / 创建失败 → 降级回退原目录并提示。
   * 默认 false（用各自 seats/<id>/ 目录已天然隔离，仅"群聊直接在真实项目仓库协作"才需要）。
   */
  isolateWorktree?: boolean
  // 「未读水位」游标：该岗位已读到第几条 Utterance（seq）。持久化防重启重读（§11.5）。
  lastSeenUtteranceSeq?: number
}

/**
 * 群聊（Room）。一个多 Agent 协作的容器。首版单群。
 */
export interface Room {
  id: string
  title: string
  // 成员名单（含 host）。
  seats: Seat[]
  hostSeatId: string
  // userData/codelf/rooms/<id>。
  rootDir: string
  // 首版固定 host-routed（决策）。
  speakingPolicy: SpeakingPolicy
  // 单次用户输入触发的最大连锁回合。默认 0 = 不限制（见 §6.4）。
  maxRounds: number
  createdAt: number
  // 主 Agent 与微信同源（决策）：指向某个微信会话。可选。
  weixinBinding?: { conversationId: string }
  // 半途崩溃恢复用：标记群是否处于「发言循环被中断」状态（§6.8）。
  interrupted?: boolean
}

/** 群共享消息流里的一条消息（transcript.jsonl 每行一条）。唯一事实源（§6.7）。 */
export interface Utterance {
  // 自增序号，全群唯一递增，用于「未读水位」游标。
  seq: number
  // 谁说的：'user' | 'system' | seatId。
  from: string
  // @ 谁：seatId 或 undefined。
  to?: string
  // 最终发言文本。
  text: string
  // 时间戳（ms）。
  ts: number
  /**
   * 可见性白名单（私信用）。undefined = 公开消息，全群可见（向后兼容旧数据）。
   * 非空数组 = 仅列出的 seatId 能在 collectUnseenFor 里读到这条（其余工人岗位不可见）。
   * 发送方（from）与接收方（to）会自动纳入。用户在 UI 拥有上帝视角，不受此限制。
   */
  visibility?: string[]
}

/**
 * 群上下文：注入岗位引擎的提示词，驱动 roomSeat 段（岗位身份段 + 群上下文段）。
 * 绝不设 isSubagent —— 这是与子 agent 区分的关键（§3.1）。
 */
export interface RoomContext {
  roomId: string
  roomTitle: string
  // 当前发言岗位。
  seat: Seat
  // 群成员简表（名字/岗位/是否群主/能力简介），供身份段与协作协议渲染。
  members: RoomMemberBrief[]
  // 当前岗位是否群主。
  isHost: boolean
}

/** 群成员简表（注入提示词用，不含敏感的完整定义）。 */
export interface RoomMemberBrief {
  id: string
  name: string
  role: string
  isHost: boolean
  enabled: boolean
  // 工人工作区根（群主验收时据此打开产物核对质量）。纯对话岗位为 null。
  workspaceRoot?: string | null
}

/**
 * 群事件：编排器把岗位引擎事件转成 RoomEvent 广播给 UI（带 seatId 归类到气泡）。
 * interactive=true 的事件（提问/审批）强制弹横幅 + 挂起循环（§7.4）。
 */
export interface RoomEvent {
  roomId: string
  seatId: string
  // 原始 agent 事件（text_delta / tool_call_* / permission_request / user_question 等）。
  payload: unknown
  // 是否「需要你回应」的交互类事件（提问/审批）。
  interactive?: boolean
  // 私密回合可见性白名单：非空表示本事件属于私聊（仅这些岗位 + 用户可见），
  // 前端据此把流式气泡路由进私聊框、并从公屏过滤掉。
  visibility?: string[]
}

// 创建群入参：运行时字段由服务计算。
// 岗位的 workspaceRoot 可省略（undefined）→ 后端自动落到 seats/<id>/；显式 null = 纯对话岗位。
export interface RoomDraft {
  title: string
  seats: Array<Omit<Seat, 'lastSeenUtteranceSeq' | 'workspaceRoot'> & { workspaceRoot?: string | null }>
  hostSeatId: string
  speakingPolicy?: SpeakingPolicy
  maxRounds?: number
  weixinBinding?: { conversationId: string }
}

// 建群后追加单个岗位用（U4）：id 可选（后端生成），不含游标/工作区（后端补全）。
export type SeatDraft = Omit<Seat, 'id' | 'lastSeenUtteranceSeq' | 'workspaceRoot'> & {
  id?: string
  workspaceRoot?: string | null
}

/**
 * 岗位客观信号快照（编排器从事件流自动采集，无需新埋点，§12.3）。
 * 既喂主管打分（§12），又触发错题本沉淀（§13）。
 */
export interface SeatSignals {
  // 返工：同一产物被反复改 / 被打回。
  reworks: number
  // 越界：触发路径围栏被拦（§6.6）。
  outOfBounds: number
  // 提问：打断用户次数（user_question）。
  questions: number
  // 报错：工具执行失败 / 引擎异常。
  errors: number
  // 任务完成度（主管验收是否通过；默认按是否产出有效发言粗估）。
  completed: boolean
  // token 消耗（input+output 估算）。
  tokens: number
  // 本周期累计耗时（ms）。
  durationMs: number
}

/**
 * 一条 KPI 考核记录（§12.5）。落盘 rooms/<roomId>/kpi/<seatId>.jsonl，每行一条可画曲线。
 */
export interface SeatKpiRecord {
  seatId: string
  // '2026-W26' / '2026-06-27'。
  period: string
  // 0-100。
  kpi: number
  // 质量/效率/自主性/协作 等维度分。
  dimensions: Record<string, number>
  highlights: string[]
  improvements: string[]
  comment: string
  // 客观信号快照（可追溯，避免主管瞎打）。
  signals: SeatSignals
  scoredAt: number
}

