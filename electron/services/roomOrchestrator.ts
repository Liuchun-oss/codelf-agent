import { randomUUID } from 'crypto'
import { resolve, isAbsolute } from 'path'
import { homedir } from 'os'
import type { AgentEvent, AiSendPayload } from '@shared/agentTypes'
import type { Room, Seat, RoomContext, RoomEvent, SeatSignals, SeatKpiRecord } from '@shared/roomTypes'
import type { AgentErrorCode } from '@shared/agentTypes'
import { QueryEngine } from '../agent/orchestrator/queryEngine'
import { ToolRegistry, buildDefaultRegistry } from '../agent/tools/registry'
import { createDeferredDiscoveryTools, SEARCH_EXTRA_TOOLS_NAME, EXECUTE_EXTRA_TOOL_NAME } from '../agent/tools/deferredTools'
import { sendToRenderer } from './localWriteRegistry'
import {
  getRoom,
  appendUtterance,
  collectUnseenFor,
  markSeen,
  markSeenUpTo,
  roomMemberBriefs,
  updateRoom,
  updateSeat,
  addSeat,
  getTranscript,
  listRooms,
  deleteRoom,
  appendKpiRecord,
  readKpiHistory
} from './roomStore'
import {
  scoreSeats,
  renderPerfSection,
  renderMistakeEntries,
  writeSeatMemory,
  type SeatReviewInput
} from './kpiReview'
import { enterWorktreeSession, exitWorktreeSession } from '../agent/orchestrator/worktreeSession'
import { readProjectMemoryContent, writeProjectMemoryContent, ensureProjectMemory, purgeSessionAndProjectMemory } from '../agent/memory/store'
import { isRetryableCode, explainError } from './roomErrorMap'
import { createRoomHostTools, createRoomWorkerTools, type MentionRecord } from '../agent/tools/roomTools'
import { INSTALL_SKILL_TOOL_NAME } from '../agent/tools/installSkillTool'
import { INSTALL_PLUGIN_TOOL_NAME } from '../agent/tools/installPluginTool'
import { MODEL_CONFIG_TOOL_NAME } from '../agent/tools/modelConfigTool'
import { MEDIA_CONFIG_TOOL_NAME } from '../agent/tools/mediaConfigTool'
import { RELOAD_MCP_TOOL_NAME } from '../agent/tools/mcpTools'
import { SCHEDULE_CREATE_NAME, SCHEDULE_LIST_NAME, SCHEDULE_DELETE_NAME, SCHEDULE_TOGGLE_NAME } from '../agent/prompts/tools/schedule'
import { notifyWeixin } from '../channels/notify'
import { getChannelsSettings } from '../agent/settings/agentSettingsStore'
import { isSensitivePath, isSystemPath, commandReferencesSensitivePath } from '../agent/permissions/pathValidation'

// 群聊编排器（RoomOrchestrator）。群聊系统唯一的核心新增件（策划书 §6）。
// 职责很薄：①决定谁说话 ②把共享消息流喂给该岗位引擎 ③把引擎事件广播回 UI + 落进 transcript。
// 引擎内部（工具/权限/记忆/压缩）完全复用，零侵入。
//
// 与子 agent 彻底分家：岗位用独立 sessionId（room:<id>:seat:<id>）+ 独立 engine map，
// 绝不碰 getQueryEngine 的全局 map，也绝不设 isSubagent（§3.1）。

// 单岗位单回合看门狗超时（参考 scheduleQueue 的 HARD_TIMEOUT_MS）。
const SEAT_TURN_TIMEOUT_MS = 5 * 60 * 1000
// 软提醒阈值：每来回 N 轮提醒一次（§6.4）。
const SOFT_REMIND_EVERY = 20
// 原地打转检测：连续 N 轮无文件改动且无新结论 → 暂停询问（§6.4）。
const SPIN_LIMIT = 6
// 绝对硬上限：任何策略下连锁回合超过此值强制停止（防 maxRounds=0 无限循环）。
const HARD_ROUND_CAP = 200

// ===== 并行协作模型（host-routed）常量 =====
// 同时后台干活的工人上限（决策：3，平衡吞吐与 API 限流/成本）。超出的派活进等位队列。
const MAX_PARALLEL_WORKERS = 3
// 单条用户输入派生的工人派发总数上限（防群主无限派活失控，替代串行模型的 HARD_ROUND_CAP）。
const MAX_DISPATCHES_PER_INPUT = 60
// 群主连续空回合（既不派活也不播报）上限：达到则认为收敛，停止 pump。
const HOST_EMPTY_TURN_LIMIT = 3

// 工人岗位禁用的「全局/跨岗位写」工具集（小写）。这些工具写 userData/家目录/全局队列，
// 会越过岗位隔离影响全员，归主管/用户级。注意 ModelConfig/MediaConfig/定时任务被标了
// readOnly:true（为跳过审批），只靠 readOnly 闸门拦不住，必须在此显式 deny。
const WORKER_DENIED_GLOBAL_TOOLS = new Set(
  [
    INSTALL_SKILL_TOOL_NAME,
    INSTALL_PLUGIN_TOOL_NAME,
    MODEL_CONFIG_TOOL_NAME,
    MEDIA_CONFIG_TOOL_NAME,
    RELOAD_MCP_TOOL_NAME,
    SCHEDULE_CREATE_NAME,
    SCHEDULE_LIST_NAME,
    SCHEDULE_DELETE_NAME,
    SCHEDULE_TOGGLE_NAME
  ].map((n) => n.toLowerCase())
)

// 「只负责调度」的主管额外禁用的「动手」工具集（小写）：写文件/改代码/删文件/跑命令/终端任务。
// 主管只应理解需求、用 mention_seat 派活、验收播报，不该自己写代码改文件。开启 dispatchOnly（默认）时生效。
// 保留：只读排查（read_file/list_dir/grep/codebase_search/get_diagnostics 等）、记笔记（append_note）、调度工具。
const HOST_DISPATCH_ONLY_DENIED_TOOLS = new Set(
  [
    'write_file',
    'edit_file',
    'multi_edit',
    'delete_file',
    'run_terminal_cmd',
    'PowerShell',
    'StartTerminalTask',
    'ReadTerminalTask',
    'StopTerminalTask',
    'WriteTerminalTask'
  ].map((n) => n.toLowerCase())
)

// 主管是否「只负责调度」：默认开启（undefined = 开启），仅显式设为 false 才放开让主管能动手。
function isDispatchOnlyHost(seat: Seat): boolean {
  return !!seat.isHost && seat.dispatchOnly !== false
}

// 一条待机主（微信）回应的交互项（host-merge：串行抛给微信，§8.4）。
interface PendingRelay {
  seatId: string
  seatName: string
  kind: 'question' | 'permission'
  requestId: string
  text: string
  suggestions?: string[]
}

// 群主待办事件（并行模型）：用户消息 / 工人完工交付 / 工人主动上报，都进 hostQueue，
// 由群主在空闲时串行消费（保证群主自身上下文一致、不并发）。
// - user：用户发的新消息/需求，群主需理解+拆解+派活，或直接回答。
// - delivery：某工人完工，群主需验收并主动播报给用户、再决定下一步。
type HostEvent =
  | { kind: 'user' }
  | { kind: 'delivery'; seatId: string; seatName: string }

type SeatState = 'idle' | 'working' | 'waiting-user' | 'paused' | 'error' | 'done'

interface SeatRuntime {
  engine: QueryEngine
  state: SeatState
  tokensUsed: number
  // KPI 客观信号累加器（§12.3/§13.4）；结算回合读取后清零进入下个周期。
  signals: SeatSignals
  // 本周期内的失败信号明细（喂错题本提取，§13.4）。
  failures: string[]
  // 本回合起始时间（算耗时）。
  turnStartedAt: number
  // 本周期写过的文件路径（重复写 = 返工信号，§12.3）。
  writtenPaths: Set<string>
  // 写冲突隔离（§9.2）：已为该岗位建好的 worktree 路径（override workspaceRoot）。null=未隔离/已降级。
  worktreeRoot: string | null
  // 是否已尝试过建 worktree（避免每回合重试失败的 git 操作）。
  worktreeResolved: boolean
  // §14.2 监工：当前步骤（来自 task_list_updated / 最近工具调用）。
  currentStep?: string
  // §14.3 最近一次故障（错误码 + 人话）。
  lastError?: { code: AgentErrorCode; message: string }
  // 私密回合（被 private_message 私密派活叫起）：本回合的最终发言也写成私密，
  // 仅 visibility 白名单内可见（= [主管, 本岗位]），不进公屏。下个回合开始时清空。
  privateReplyVisibility?: string[]
  // 私密回合的来源：'host'=主管私信派活；'user'=用户直接私聊该岗位。
  // 决定本回合提示词口吻（对主管私下汇报 vs 直接回复用户），避免用户私聊时工人误把用户当主管。
  privateReplySource?: 'host' | 'user'
}

interface RoomRuntime {
  room: Room
  seats: Map<string, SeatRuntime>   // seatId -> 运行态（懒加载引擎）
  running: boolean                  // 是否有发言循环在跑
  mentionQueue: MentionRecord[]          // host 本回合批量 @ 的岗位队列（依次排空后再回主管，支持一次给多个岗位派活）
  abort: AbortController | null
  noProgressStreak: number
  pendingUserInputs: Array<{ text: string; mention?: string; fromWeixin?: boolean; alreadyPosted?: boolean }>  // 并发输入排队（§11.4）
  // 微信遥控（§8.4）：本群是否经微信发起（决定是否把节点/提问推微信）。
  weixinRelay: boolean
  // host-merge：待机主回应的交互项队列（微信线性聊天，同一时刻只抛一个）。
  relayQueue: PendingRelay[]
  // 当前已抛给微信、等回应的交互项。
  activeRelay: PendingRelay | null
  // round-robin：下一个轮到的工人岗位下标（§6.3 阶段4）。
  roundRobinIdx: number
  // round-robin：标记当前 host 回合是「收口」（一圈已转完）而非「起手」，收口后结束。
  rrClosing: boolean
  // 被用户暂停的岗位（不参与调度，§7.2 暂停/恢复）。手动暂停，持久跨循环。
  pausedSeats: Set<string>
  // 因报错被自动摘除的岗位（§14.3）。与手动暂停区分：每条新发言循环开始时清空，
  // 让岗位在新任务上有重新尝试的机会，不会被一次偶发故障永久打入冷宫。
  erroredSeats: Set<string>
  // ===== 并行协作模型（host-routed）运行态 =====
  // 群主待办队列（用户消息 / 工人交付），群主空闲时串行消费。
  hostQueue: HostEvent[]
  // 群主是否正在跑回合（群主自身仍串行，一次只处理一个 HostEvent）。
  hostBusy: boolean
  // 正在后台并行干活的工人 seatId（上限 MAX_PARALLEL_WORKERS）。
  activeWorkers: Set<string>
  // 等位的工人 seatId（并发已满、或目标正忙需排队补跑）。任务内容已落 transcript，故只需记 id。
  workerWaitQueue: string[]
  // 本轮（自上次完全空闲以来）累计派发数，用于 MAX_DISPATCHES_PER_INPUT 失控保护。
  dispatchCount: number
  // 群主连续空回合计数（既不派活也不播报），达 HOST_EMPTY_TURN_LIMIT 停止 pump。
  hostEmptyStreak: number
  // 本群是否走并行调度（host-routed）。round-robin/free 仍走原串行 runSpeakingLoop。
  parallelMode: boolean
  // 用户点了中断：并行调度停摆，新工人/群主回合都不再起，直到下一条用户消息复位。
  stopping: boolean
  // 并行模型「完全空闲」一次性通知去重：避免每次 recomputeRunning 都重复推微信完工通知。
  idleNotified: boolean
  // 调度世代（epoch）：每次 stop() 自增。后台工人 async 任务记住起跑时的 epoch，
  // 完工回调若发现 epoch 已变（中途被 stop 过），则丢弃其交付/唤醒动作，避免被中断的
  // 陈旧任务在新一轮里推送过期交付、错误唤醒群主。
  schedEpoch: number
}

class RoomOrchestrator {
  private runtimes = new Map<string, RoomRuntime>()

  // 取或建群运行态（懒加载，§6.8）。
  private getRuntime(roomId: string): RoomRuntime | null {
    const existing = this.runtimes.get(roomId)
    if (existing) return existing
    const room = getRoom(roomId)
    if (!room) return null
    const rt: RoomRuntime = {
      room,
      seats: new Map(),
      running: false,
      mentionQueue: [],
      abort: null,
      noProgressStreak: 0,
      pendingUserInputs: [],
      weixinRelay: false,
      relayQueue: [],
      activeRelay: null,
      roundRobinIdx: 0,
      rrClosing: false,
      pausedSeats: new Set(),
      erroredSeats: new Set(),
      hostQueue: [],
      hostBusy: false,
      activeWorkers: new Set(),
      workerWaitQueue: [],
      dispatchCount: 0,
      hostEmptyStreak: 0,
      parallelMode: room.speakingPolicy === 'host-routed',
      stopping: false,
      idleNotified: true,
      schedEpoch: 0
    }
    this.runtimes.set(roomId, rt)
    return rt
  }

  // __METHODS__

  // 为某岗位构建「过滤后的 registry」（照搬 subagentRegistry 范式）。
  // 主 Agent 额外注入 mention_seat/list_seats；工人岗位剔除 run_subagent（双保险）。
  private buildSeatRegistry(rt: RoomRuntime, seat: Seat): ToolRegistry {
    const registry = new ToolRegistry()
    const allowed = seat.allowedTools ? new Set(seat.allowedTools.map((n) => n.toLowerCase())) : null
    const denied = new Set((seat.deniedTools ?? []).map((n) => n.toLowerCase()))
    if (!seat.isHost) {
      denied.add('run_subagent')
      // 工人岗位禁掉所有「写全局/跨岗位共享态」的工具：skill 装到全局 ~/.codelf/skills、
      // plugin/MCP/模型/媒体配置写 userData、定时任务进全局队列——这些都会越过岗位隔离影响全员。
      // 这类操作归主管/用户级，工人专心干活（决策：全部收口）。
      for (const n of WORKER_DENIED_GLOBAL_TOOLS) denied.add(n)
    } else if (isDispatchOnlyHost(seat)) {
      // 「只负责调度」的主管：工具层强制禁掉动手类工具，从根上杜绝主管自己写代码/改文件/跑命令。
      for (const n of HOST_DISPATCH_ONLY_DENIED_TOOLS) denied.add(n)
    }
    // 发现工具（SearchExtraTools/ExecuteExtraTool）的闭包必须绑定本岗位 registry，
    // 否则 deferred/MCP 工具的发现与执行会落到源 registry 上，绕开本岗位的 readOnly/denied
    // 过滤（穿透漏洞）。这里跳过从源复制的那两个工具，下面用本 registry 重新挂一对。
    const discoveryNames = new Set([SEARCH_EXTRA_TOOLS_NAME.toLowerCase(), EXECUTE_EXTRA_TOOL_NAME.toLowerCase()])
    for (const tool of buildDefaultRegistry().availableTools()) {
      const name = tool.name.toLowerCase()
      if (discoveryNames.has(name)) continue
      if (seat.readOnly && !tool.readOnly) continue
      if (allowed && !allowed.has(name)) continue
      if (denied.has(name)) continue
      registry.register(tool)
    }
    // 绑定到本岗位 registry 的发现工具对：发现/执行口径与过滤后的工具集一致。
    for (const tool of createDeferredDiscoveryTools({
      listDeferredTools: () => registry.listDeferredToolSummaries(),
      markDeferredToolDiscovered: (name) => registry.markDeferredToolDiscovered(name),
      isDeferredToolDiscovered: (name) => registry.isDeferredToolDiscovered(name),
      executeDeferredTool: (name, input, ctx) => registry.run(name, input, ctx)
    })) {
      registry.register(tool)
    }
    if (seat.isHost) {
      for (const tool of createRoomHostTools({
        roomId: rt.room.id,
        hostSeatId: seat.id,
        recordMention: (m) => { rt.mentionQueue.push(m) },
        describeProgress: () => this.describeProgress(rt.room.id)
      })) {
        registry.register(tool)
      }
    } else {
      // 工人岗位：注入「队友私语」工具（写带 visibility 白名单的留言进 transcript，支持群发小队）。
      for (const tool of createRoomWorkerTools({
        roomId: rt.room.id,
        selfSeatId: seat.id,
        recordWhisper: (toSeatIds, message) => {
          const text = message.trim()
          if (!text || toSeatIds.length === 0) return false
          // 可见性白名单 = 自己 + 全部接收方（去重）。to 取第一个接收方仅作 UI 定向标注。
          const visibility = [...new Set([seat.id, ...toSeatIds])]
          const u = appendUtterance(rt.room.id, { from: seat.id, to: toSeatIds[0], text, visibility })
          // 实时广播，否则被私语的队友要等重进群才看到（私聊框收不到对方私语）。
          sendToRenderer('room:utterance', { roomId: rt.room.id, utterance: u })
          return true
        }
      })) {
        registry.register(tool)
      }
    }
    return registry
  }

  // 取或建某岗位的引擎运行态（懒加载，§6.8）。
  private getSeatRuntime(rt: RoomRuntime, seat: Seat): SeatRuntime {
    const existing = rt.seats.get(seat.id)
    if (existing) return existing
    const engine = new QueryEngine(this.buildSeatRegistry(rt, seat))
    const sr: SeatRuntime = { engine, state: 'idle', tokensUsed: 0, signals: freshSignals(), failures: [], turnStartedAt: 0, writtenPaths: new Set(), worktreeRoot: null, worktreeResolved: false }
    rt.seats.set(seat.id, sr)
    return sr
  }

  // 主 Agent 与微信「完全同源」（§8）：若群绑定了微信，host 的人设取自微信已激活人格，
  // workspaceRoot 指向微信会话工作区（sha256 相同 → 同一份 MEMORY.md，记忆同源 §11.1）。
  // 工人岗位原样返回（各自独立记忆，与 host 同源不矛盾）。
  private resolveEffectiveSeat(rt: RoomRuntime, seat: Seat): Seat {
    if (!seat.isHost || !rt.room.weixinBinding) return seat
    const wx = getChannelsSettings().weixin
    if (!wx.persona.activated) return seat
    const p = wx.persona
    const personaLines = [
      seat.personaPrompt,
      `（微信同源人格）你的名字：${p.selfName}；主人：${p.ownerName}；你称呼主人为「${p.addressing}」；风格：${p.style}。`,
      '你在微信里和在这个群里是同一个人，记得同样的事。'
    ].filter((s) => s && s.trim())
    return {
      ...seat,
      personaPrompt: personaLines.join('\n'),
      // 记忆同源：host 工作区指向微信绑定的工作区（为空则保持原值）。
      workspaceRoot: wx.workspaceRoot?.trim() ? wx.workspaceRoot.trim() : seat.workspaceRoot
    }
  }

  // 广播一条 RoomEvent 给 UI（带 seatId 归类到气泡，§7.3）。
  // visibility：私密回合的可见性白名单，前端据此把流式气泡路由进私聊框、并从公屏过滤。
  private broadcast(roomId: string, seatId: string, payload: AgentEvent, interactive = false, visibility?: string[]): void {
    const ev: RoomEvent = {
      roomId,
      seatId,
      payload,
      ...(interactive ? { interactive: true } : {}),
      ...(visibility && visibility.length ? { visibility } : {})
    }
    sendToRenderer('room:event', ev)
  }

  // 系统提示进 transcript + 广播（岗位失败、软提醒等）。
  private systemNote(roomId: string, text: string): void {
    appendUtterance(roomId, { from: 'system', text })
    sendToRenderer('room:system', { roomId, text })
  }

  // 写入一条用户消息并广播给前端（room:utterance）。桌面发起时前端已乐观插入，
  // 但微信发起的消息前端无从得知 → 必须广播，否则 codelf 界面看不到机主在微信发的话。
  // visibility：用户私聊某岗位时带白名单（仅该岗位可见），让这条用户私聊也不进公屏、不被其他岗位读到。
  private appendUserUtterance(roomId: string, text: string, to?: string, visibility?: string[]): void {
    const u = appendUtterance(roomId, {
      from: 'user',
      text,
      ...(to ? { to } : {}),
      ...(visibility && visibility.length ? { visibility } : {})
    })
    sendToRenderer('room:utterance', { roomId, utterance: u })
  }

  // 写冲突隔离（§9.2 进阶）：若岗位开启 isolateWorktree 且 workspaceRoot 是 git 仓，
  // 为其建/进一个独立 worktree（一次性，结果缓存）。失败降级回退原目录并系统提示。
  // 返回 workspaceRoot 已被替换为 worktree 路径的 effSeat（或原样）。
  private ensureSeatWorktree(rt: RoomRuntime, seat: Seat, eff: Seat): Seat {
    if (!seat.isolateWorktree || !eff.workspaceRoot) return eff
    const sr = rt.seats.get(seat.id)
    if (!sr) return eff
    if (sr.worktreeResolved) {
      return sr.worktreeRoot ? { ...eff, workspaceRoot: sr.worktreeRoot } : eff
    }
    sr.worktreeResolved = true
    const sessionId = `room:${rt.room.id}:seat:${seat.id}`
    const name = `room-${rt.room.id}-seat-${seat.id}`.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64)
    const res = enterWorktreeSession({ sessionId, workspaceRoot: eff.workspaceRoot, name })
    if ('error' in res) {
      this.systemNote(rt.room.id, `岗位「${seat.name}」启用了 worktree 隔离，但创建失败（${res.error}），已降级回退原工作区。`)
      sr.worktreeRoot = null
      return eff
    }
    sr.worktreeRoot = res.worktreePath
    this.systemNote(rt.room.id, `岗位「${seat.name}」已进入独立 worktree（分支 ${res.branchName}），写操作隔离在副本中。`)
    return { ...eff, workspaceRoot: res.worktreePath }
  }

  // §6.6 权限自动裁决（全放行策略）：不再弹授权横幅打断用户——危险命令也自动放行。
  // 仅保留一道静默红线：密钥文件 / 系统目录 → deny（谁都不能碰，安全网，不弹窗）。
  // - 写类（带 path）：命中密钥文件 / 系统目录 → deny；否则 allow。
  // - 终端命令（带 command）：引用密钥/系统路径 → deny；否则一律 allow（含 rm -rf、git push 等）。
  // - 相对路径按岗位工作区解析后再判红线（与 resolveAnyPath 同口径）。
  // - 既无 path 也无 command（如 append_note/todo_write 等纯应用内工具）：无副作用 → allow。
  private autoResolvePermission(seat: Seat, ev: Extract<AgentEvent, { type: 'permission_request' }>): 'allow' | 'deny' | 'ask' {
    const d = ev.details
    if (d?.path) {
      return this.crossesRedline(seat, d.path) ? 'deny' : 'allow'
    }
    if (d?.command) {
      if (commandReferencesSensitivePath(d.command)) return 'deny'
      const paths = [...absolutePathsIn(d.command), ...relativePathsIn(d.command)]
      if (paths.some((p) => this.crossesRedline(seat, p))) return 'deny'
      return 'allow'
    }
    return 'allow'
  }

  // 硬红线：密钥文件（secrets）与系统目录，任何岗位都不能写/动。相对路径按岗位工作区解析。
  private crossesRedline(seat: Seat, targetPath: string): boolean {
    const abs = isAbsolute(targetPath)
      ? targetPath
      : (seat.workspaceRoot ? resolve(seat.workspaceRoot, targetPath) : resolve(targetPath))
    return isSensitivePath(abs) || isSystemPath(abs)
  }

  // 组装注入岗位引擎的 roomContext（驱动 roomSeat 提示词段）。
  private buildRoomContext(rt: RoomRuntime, seat: Seat): RoomContext {
    return {
      roomId: rt.room.id,
      roomTitle: rt.room.title,
      seat,
      members: roomMemberBriefs(rt.room.id),
      isHost: !!seat.isHost
    }
  }

  // ===== 公开入口：用户发一条消息进群（§6.1）=====
  // fromWeixin=false（桌面发起，默认）：关掉 weixinRelay——你已回到桌面，本群交互不再推微信，
  //   直到下次用微信 /room 再开启（B3-2 决策：桌面一有操作就关推送）。
  async postUserMessage(roomId: string, text: string, mention?: string, fromWeixin = false, alreadyPosted = false): Promise<void> {
    const rt = this.getRuntime(roomId)
    if (!rt) throw new Error(`群不存在：${roomId}`)
    if (!fromWeixin) rt.weixinRelay = false

    // ===== 并行模型（host-routed）：用户消息不阻塞、不排队等待 =====
    // 直接落消息流 → 进 hostQueue → 唤醒群主。群主忙就排队等群主下个空档，
    // 工人在后台并行干活，互不阻塞。用户因此随时能和群主对话（核心诉求）。
    if (rt.parallelMode) {
      if (!alreadyPosted) this.appendUserUtterance(roomId, text, mention)
      // 被 @ 指定某工人：用户想直接找这个工人（等价于一次定向私聊单回合），不打扰群主。
      if (mention && mention !== rt.room.hostSeatId) {
        const target = rt.room.seats.find((s) => s.id === mention || s.name === mention)
        if (target && !target.isHost) { void this.privateChat(roomId, target.id, text, true); return }
      }
      // 新的用户输入 = 一段新交互，复位失控计数（群主可以重新放心派活）。
      rt.dispatchCount = 0
      rt.hostEmptyStreak = 0
      rt.stopping = false
      rt.hostQueue.push({ kind: 'user' })
      this.pumpHost(rt)
      return
    }

    // ===== 串行模型（round-robin / free）：维持原「循环跑着时排队」语义 =====
    if (rt.running) {
      this.appendUserUtterance(roomId, text, mention)
      rt.pendingUserInputs.push({ text, mention, fromWeixin, alreadyPosted: true })
      return
    }
    if (!alreadyPosted) this.appendUserUtterance(roomId, text, mention)
    const host = rt.room.seats.find((s) => s.id === rt.room.hostSeatId)
    const firstSeat = mention ? rt.room.seats.find((s) => s.id === mention || s.name === mention) ?? host : host
    if (!firstSeat) throw new Error('群里没有主 Agent')
    await this.runSpeakingLoop(rt, firstSeat)
  }

  // ===== 微信遥控入口（§8.4）=====
  // 机主在微信里发指令 → ChannelManager 转交这里。标记 weixinRelay，
  // 之后的关键节点（开工/交付/出错）与提问/审批都会推回微信。
  async postUserMessageFromWeixin(roomId: string, text: string, mention?: string): Promise<void> {
    const rt = this.getRuntime(roomId)
    if (!rt) { void notifyWeixin(`群不存在：${roomId}`); return }
    rt.weixinRelay = true
    // 若有正在等机主回应的交互项，这条消息应作为「回答」而非新任务（host-relay）。
    if (rt.activeRelay) {
      this.answerActiveRelay(rt, text)
      return
    }
    void notifyWeixin('收到，已安排团队开工。完成或遇到问题我再回你。')
    await this.postUserMessage(roomId, text, mention, true)
  }

  // 把机主的微信回复回填给当前挂起的岗位（提问→答案；审批→同意/拒绝）。
  private answerActiveRelay(rt: RoomRuntime, text: string): void {
    const relay = rt.activeRelay
    if (!relay) return
    const sr = rt.seats.get(relay.seatId)
    if (relay.kind === 'permission') {
      // 与桌面/微信 resolvePermissionReply 对齐：仅明确「同意/拒绝」才裁决，
      // 模糊回复不擅自授权（默认更安全），回提示让机主复述，保留 activeRelay 不前进。
      const decision = parsePermissionReply(text)
      if (!decision) {
        void notifyWeixin(`【${relay.seatName}】仍在等授权，请明确回复『同意』或『拒绝』。`)
        return
      }
      sr?.engine.resolvePermission(relay.requestId, decision)
    } else {
      sr?.engine.resolveUserQuestion(relay.requestId, { answer: text })
    }
    rt.activeRelay = null
    this.pumpRelayQueue(rt)
  }

  // host-merge：把队列里下一个交互项抛给微信（同一时刻只抛一个，§8.4）。
  private pumpRelayQueue(rt: RoomRuntime): void {
    if (rt.activeRelay || rt.relayQueue.length === 0) return
    const next = rt.relayQueue.shift()!
    rt.activeRelay = next
    const hint = next.kind === 'permission'
      ? '回复『同意』或『拒绝』。'
      : next.suggestions?.length ? `可选：${next.suggestions.join(' / ')}` : '回复你的想法即可。'
    void notifyWeixin(`【${next.seatName}】${next.kind === 'permission' ? '请求授权' : '问'}：${next.text}\n${hint}`)
  }

  // 入队一个交互项，并尝试立即抛出（队列空时）。
  private enqueueRelay(rt: RoomRuntime, relay: PendingRelay): void {
    if (rt.relayQueue.some((r) => r.requestId === relay.requestId) || rt.activeRelay?.requestId === relay.requestId) return
    rt.relayQueue.push(relay)
    this.pumpRelayQueue(rt)
  }

  // 发言循环：一个岗位说完 → 看是否触发下一个 → 直到收敛或达上限（§6.1）。
  private async runSpeakingLoop(rt: RoomRuntime, startSeat: Seat): Promise<void> {
    rt.running = true
    rt.abort = new AbortController()
    // 复位「循环私有」的收敛状态：它们只在一条连锁内有意义，跨循环残留会导致新一轮被误判。
    // - noProgressStreak 残留 ≥SPIN_LIMIT → 新消息在循环顶部即被「无进展」break，永远跑不起来。
    // - rrClosing 残留 true → round-robin 下主管首回合后直接收口，工人岗位全被跳过。
    rt.noProgressStreak = 0
    rt.rrClosing = false
    // 报错摘除的岗位在新一轮发言时恢复可调度（手动暂停的 pausedSeats 不动），避免偶发故障永久冷藏。
    for (const seatId of rt.erroredSeats) {
      const sr = rt.seats.get(seatId)
      if (sr && sr.state === 'error') { sr.state = 'idle'; sr.lastError = undefined }
    }
    rt.erroredSeats.clear()
    this.broadcastRunning(rt.room.id, true)
    if (rt.room.interrupted) updateRoom(rt.room.id, { interrupted: false })
    let next: Seat | null = startSeat
    let rounds = 0
    try {
      while (next && !rt.abort.signal.aborted) {
        rounds++
        if (rounds > HARD_ROUND_CAP) {
          this.systemNote(rt.room.id, `已达硬上限（${HARD_ROUND_CAP} 轮），强制停止以防失控。`)
          break
        }
        if (rt.room.maxRounds > 0 && rounds > rt.room.maxRounds) {
          this.systemNote(rt.room.id, `已达最大连锁回合数（${rt.room.maxRounds}），本轮停止。`)
          break
        }
        if (rounds % SOFT_REMIND_EVERY === 0) {
          this.systemNote(rt.room.id, `提醒：已来回 ${rounds} 轮，仍在继续。如需停止可点中断。`)
        }
        if (rt.noProgressStreak >= SPIN_LIMIT) {
          this.systemNote(rt.room.id, '检测到多轮无实质进展，已暂停。请补充指示或确认是否继续。')
          break
        }
        next = await this.runSeatTurn(rt, next)
      }
    } finally {
      rt.running = false
      rt.abort = null
      // 微信遥控：循环收敛（无挂起交互项）→ 推一次最终交付节点（result-only §8.4）。
      if (rt.weixinRelay && !rt.activeRelay && rt.pendingUserInputs.length === 0) {
        const delivery = this.lastHostDelivery(rt)
        void notifyWeixin(delivery ? `✓ 完成：${delivery}` : '✓ 本轮已完成。')
      }
      const hasMore = rt.pendingUserInputs.length > 0
      // 还有排队输入会立刻再起循环 → 不广播 idle，避免中断按钮闪烁（U6）。
      if (!hasMore) this.broadcastRunning(rt.room.id, false)
      await this.drainPendingInputs(rt)
    }
  }

  // 广播群级运行态（U6：让中断按钮在整轮连锁期间稳定显示，不随单岗位 idle 闪烁）。
  private broadcastRunning(roomId: string, running: boolean): void {
    sendToRenderer('room:running', { roomId, running })
  }

  // 取本群最近一条主管发言作为交付摘要（推微信用）。
  // 不截断：微信适配器的 notify 已用 chunkText(4000) 自动把长文本分多条发送，
  // 这里返回完整原文即可，避免正经交付被拦腰截断。
  private lastHostDelivery(rt: RoomRuntime): string {
    const hostMsgs = getTranscript(rt.room.id).filter((u) => u.from === rt.room.hostSeatId)
    return hostMsgs[hostMsgs.length - 1]?.text ?? ''
  }

  // 处理积压的并发用户输入（循环结束后，§11.4）。
  private async drainPendingInputs(rt: RoomRuntime): Promise<void> {
    const queued = rt.pendingUserInputs.shift()
    if (!queued) return
    await this.postUserMessage(rt.room.id, queued.text, queued.mention, queued.fromWeixin ?? false, queued.alreadyPosted ?? false)
  }

  // ============================================================
  // ===== 并行协作模型（host-routed）调度核心 =====
  // 设计：群主常驻、串行消费 hostQueue（用户消息/工人交付）；工人在各自 async 任务里后台并行
  // 干活（上限 MAX_PARALLEL_WORKERS），互不阻塞群主。工人完工 → 写交付 → 唤醒群主验收播报。
  // ============================================================

  // 群主泵：群主空闲且 hostQueue 有待办时，取一条跑一个群主回合。群主自身永远串行（hostBusy 守卫）。
  private pumpHost(rt: RoomRuntime): void {
    if (rt.hostBusy || rt.stopping) return
    if (rt.hostQueue.length === 0) return
    if (rt.hostEmptyStreak >= HOST_EMPTY_TURN_LIMIT) {
      // 群主连续空回合：判定收敛，清空待办避免空转。等下一条用户消息复位再启。
      rt.hostQueue = []
      this.systemNote(rt.room.id, '群主连续多轮无新动作，已停下等待你的进一步指示。')
      this.recomputeRunning(rt)
      return
    }
    const host = rt.room.seats.find((s) => s.id === rt.room.hostSeatId)
    if (!host) return
    // 合并消费：把当前 hostQueue 里所有待办一次性吞掉（群主回合会通过 collectUnseenFor
    // 读到所有未读消息——含多个工人的交付），避免每条交付都单独跑一次群主、重复播报。
    rt.hostQueue = []
    rt.hostBusy = true
    // interrupted 标记由 recomputeRunning 统一管理（运行中置 true、完全空闲清 false）。
    this.recomputeRunning(rt)
    void this.runHostTurn(rt, host)
  }

  // 跑一个群主回合（后台），结束后读 mentionQueue 派活、再尝试继续 pump。
  private async runHostTurn(rt: RoomRuntime, host: Seat): Promise<void> {
    let dispatched = 0
    let spoke = false
    const epoch = rt.schedEpoch
    try {
      const before = getTranscript(rt.room.id).length
      await this.runSeatTurn(rt, host)
      // runSeatTurn 内部：非空发言才 append。用 transcript 增量粗判群主本回合是否真的说了话。
      spoke = getTranscript(rt.room.id).length > before
      // 中途被 stop（epoch 变）：本回合作废，不派活、不继续 pump。
      if (epoch !== rt.schedEpoch) return
      // 读群主本回合积累的派发意图，逐个尝试起工人（受并发上限/失控保护约束）。
      const mentions = rt.mentionQueue
      rt.mentionQueue = []
      for (const m of mentions) {
        if (rt.stopping) break
        if (rt.dispatchCount >= MAX_DISPATCHES_PER_INPUT) {
          this.systemNote(rt.room.id, `本轮派发已达上限（${MAX_DISPATCHES_PER_INPUT}），暂停派活以防失控。`)
          break
        }
        if (this.dispatchToWorker(rt, m)) dispatched++
      }
    } catch (e) {
      this.systemNote(rt.room.id, `群主回合异常：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      // 仅当本回合仍属当前世代时才回写群主忙闲与继续 pump（被 stop 作废的回合不干扰新一轮）。
      if (epoch === rt.schedEpoch) {
        rt.hostBusy = false
        // 空回合检测：群主既没说话也没派活 → 计入空回合 streak（pumpHost 据此熔断空转）。
        if (!spoke && dispatched === 0) rt.hostEmptyStreak++
        else rt.hostEmptyStreak = 0
        this.recomputeRunning(rt)
        // 群主回合产生了新待办（期间用户又发言/工人又交付）→ 继续 pump。
        this.pumpHost(rt)
      }
    }
  }

  // 把一条群主派活意图落地为工人任务：写任务消息进 transcript，然后起/排队工人。
  // 返回是否成功受理（无效目标返回 false）。
  private dispatchToWorker(rt: RoomRuntime, m: MentionRecord): boolean {
    const hostId = rt.room.hostSeatId
    const target = rt.room.seats.find((s) => s.id === m.seatId)
    if (!target || !target.enabled || this.isUnavailable(rt, target.id) || target.id === hostId) return false
    // 任务作为定向消息进消息流（私信带 visibility 白名单，仅主管+目标可见）。
    if (m.task && m.task.trim()) {
      const u = appendUtterance(rt.room.id, {
        from: hostId,
        to: target.id,
        text: m.task.trim(),
        ...(m.private ? { visibility: [hostId, target.id] } : {})
      })
      sendToRenderer('room:utterance', { roomId: rt.room.id, utterance: u })
    }
    const sr = this.getSeatRuntime(rt, target)
    sr.privateReplyVisibility = m.private ? [hostId, target.id] : undefined
    sr.privateReplySource = m.private ? 'host' : undefined
    rt.dispatchCount++
    // 目标已在干活（或并发已满）→ 排队补位；否则立即后台起跑。
    if (rt.activeWorkers.has(target.id) || rt.activeWorkers.size >= MAX_PARALLEL_WORKERS) {
      if (!rt.workerWaitQueue.includes(target.id)) rt.workerWaitQueue.push(target.id)
    } else {
      this.spawnWorker(rt, target)
    }
    return true
  }

  // 后台并行跑一个工人回合（不 await）。完工 → 释放名额 → 唤醒群主验收 → 补位下一个等待者。
  private spawnWorker(rt: RoomRuntime, seat: Seat): void {
    if (rt.stopping) return
    const epoch = rt.schedEpoch
    rt.activeWorkers.add(seat.id)
    this.recomputeRunning(rt)
    void (async () => {
      try {
        await this.runSeatTurn(rt, seat)
      } catch (e) {
        this.systemNote(rt.room.id, `岗位「${seat.name}」执行异常：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        rt.activeWorkers.delete(seat.id)
        // 世代校验：若起跑后经历过 stop（epoch 变化），本任务已属「上一轮」，丢弃其交付/唤醒/补位，
        // 避免被中断的陈旧任务污染新一轮调度。仅做名额回收（上面已 delete）。
        const stale = epoch !== rt.schedEpoch
        // 完工唤醒群主：工人的发言已由 runSeatTurn 落进 transcript，群主回合会经 collectUnseenFor 读到。
        // 这里只负责把「该验收了」事件塞进 hostQueue 并 pump（群主空闲则立即起回合，忙则排队）。
        if (!rt.stopping && !stale) {
          rt.hostQueue.push({ kind: 'delivery', seatId: seat.id, seatName: seat.name })
          // 工人交付理应重新激活群主（即便之前判过空回合收敛）：复位 streak，确保播报不被熔断吞掉。
          rt.hostEmptyStreak = 0
          this.pumpHost(rt)
        }
        // 补位：并发有空档则从等位队列拉下一个（跳过仍在跑的）。
        if (!stale) this.fillWorkerSlots(rt)
        this.recomputeRunning(rt)
      }
    })()
  }

  // 并发有空档时，从等位队列依次起下一个工人（跳过已在跑的）。
  private fillWorkerSlots(rt: RoomRuntime): void {
    while (!rt.stopping && rt.activeWorkers.size < MAX_PARALLEL_WORKERS && rt.workerWaitQueue.length > 0) {
      const nextId = rt.workerWaitQueue.shift()!
      if (rt.activeWorkers.has(nextId)) continue
      const seat = rt.room.seats.find((s) => s.id === nextId)
      if (!seat || !seat.enabled || this.isUnavailable(rt, seat.id)) continue
      this.spawnWorker(rt, seat)
    }
  }

  // 重算并广播群级运行态（并行模型）：群主在忙 或 有工人在跑 或 还有待办/等位 → running。
  // 额外：检测「忙→完全空闲」跃迁，触发一次性收敛动作（微信完工通知 + 清 interrupted 标记）。
  private recomputeRunning(rt: RoomRuntime): void {
    if (!rt.parallelMode) return
    const running = rt.hostBusy || rt.activeWorkers.size > 0 || rt.hostQueue.length > 0 || rt.workerWaitQueue.length > 0
    this.broadcastRunning(rt.room.id, running)
    if (running) {
      // 一进入运行态就标记「未完成」：若 app 在并行干活中途退出，下次启动 UI 可据此提示恢复。
      if (!rt.room.interrupted) updateRoom(rt.room.id, { interrupted: true })
      rt.idleNotified = false
      return
    }
    // 完全空闲（一次性，避免每次 recompute 都触发）。
    if (rt.idleNotified) return
    rt.idleNotified = true
    // 收敛：清掉「未完成」标记（本轮已干完，不是半途崩溃）。
    if (rt.room.interrupted) updateRoom(rt.room.id, { interrupted: false })
    // 微信遥控：本轮收敛且无挂起交互项 → 推一次最终交付（与串行模型 runSpeakingLoop 的 finally 对齐）。
    if (rt.weixinRelay && !rt.activeRelay && !rt.stopping) {
      const delivery = this.lastHostDelivery(rt)
      void notifyWeixin(delivery ? `✓ 完成：${delivery}` : '✓ 本轮已完成。')
    }
  }


  // ===== 单个岗位发言一回合（§6.2）=====
  // 返回下一个该发言的岗位（host-routed：host 用 mention_seat 指定；工人岗位默认回主管）。
  private async runSeatTurn(rt: RoomRuntime, seat: Seat): Promise<Seat | null> {
    const sr = this.getSeatRuntime(rt, seat)
    sr.state = 'working'
    sr.turnStartedAt = Date.now()
    // 仅在 host 回合开始时清空派发队列：host 本回合可能批量 @ 多个岗位（mention_seat/private_message
    // 调多次），队列在 nextHostRouted 里依次排空；工人回合不能清，否则排队中的后续岗位会丢失。
    if (seat.isHost) rt.mentionQueue = []

    // host 同源覆盖（微信人格 + 工作区），工人岗位原样（§8/§11.1）。
    const effSeat0 = this.resolveEffectiveSeat(rt, seat)
    // 写冲突隔离（§9.2）：开关开启且 workspaceRoot 是 git 仓 → 切到独立 worktree 副本。
    const effSeat = this.ensureSeatWorktree(rt, seat, effSeat0)
    const sessionId = `room:${rt.room.id}:seat:${seat.id}`
    const incoming = collectUnseenFor(rt.room.id, seat.id)
    // 并行安全：记录本回合实际读到的最大 seq。发言期间别的工人可能并发追加更大 seq 的消息，
    // 回合结束只把游标推进到这个快照点（markSeenUpTo），不会把没读过的并发消息误标已读。
    const maxSeenSeq = incoming.length ? incoming[incoming.length - 1].seq : 0
    const nameOf = (id: string): string => rt.room.seats.find((s) => s.id === id)?.name ?? id
    const prompt = renderGroupTranscript(incoming, !!seat.isHost, sr.privateReplyVisibility ? (sr.privateReplySource ?? 'host') : false, nameOf, rt.parallelMode)

    // 终端/命令工具的运行根：岗位 workspaceRoot 为空（主管/纯对话岗位 = null）时，
    // 回退到用户家目录，否则 PowerShell/terminal 等工具会一律「未打开工作区」直接失败，
    // 岗位反复重试卡死、对工作区以外目录（含 D:\projects\... 这类绝对路径）也动不了（修复 bug3）。
    // 注意：仅给「命令执行的 cwd」兜底，记忆绑定仍用基础工作区，不受影响。
    const execCwd = effSeat.workspaceRoot ?? safeHomeDir()

    const payload: AiSendPayload = {
      sessionId,
      turnId: randomUUID(),
      message: prompt,
      sessionCwd: execCwd,
      // 每岗位模型：用 seat.modelProfileId（不设则引擎回退到全局激活 profile）。
      ...(seat.modelProfileId ? { profileId: seat.modelProfileId } : {}),
      // 记忆绑定基础工作区（worktree 隔离前），不随临时副本漂移 → KPI/注入/UI 三处同源（§9.2 决策）。
      memoryWorkspaceRoot: effSeat0.workspaceRoot,
      // 用 default 模式：写操作走 file_change_proposed 事件，由编排器做路径围栏判定（§6.6）。
      permissionMode: 'default',
      roomContext: this.buildRoomContext(rt, effSeat)
    }

    const finalText = await this.consumeSeatEvents(rt, effSeat, sr, payload)
    // 并行模型用 markSeenUpTo（只推进到本回合读到的快照），串行模型沿用 markSeen（推到最新）。
    if (rt.parallelMode) markSeenUpTo(rt.room.id, seat.id, maxSeenSeq)
    else markSeen(rt.room.id, seat.id)
    sr.signals.durationMs += Date.now() - sr.turnStartedAt
    // 私密回合：本回合的最终发言也写成私密（仅主管+本岗位可见），不进公屏。读取后清空（一次性）。
    const replyVisibility = sr.privateReplyVisibility
    sr.privateReplyVisibility = undefined
    sr.privateReplySource = undefined
    // 空发言不写 transcript（§11.6）；非空才进事实源。
    const trimmed = finalText.trim()
    if (trimmed) {
      appendUtterance(rt.room.id, {
        from: seat.id,
        text: trimmed,
        ...(replyVisibility && replyVisibility.length ? { visibility: replyVisibility } : {})
      })
      rt.noProgressStreak = 0
      sr.signals.completed = true
    } else {
      rt.noProgressStreak++
    }
    sr.state = (sr.state as SeatState) === 'error' ? 'error' : 'idle'
    // 并行模型：下一步由 pumpHost/dispatchToWorker 驱动，不走串行的 resolveNextSpeaker
    // （否则 host 回合会在这里 dequeueMention，与 runHostTurn 读 mentionQueue 重复消费）。
    if (rt.parallelMode) return null
    return this.resolveNextSpeaker(rt, seat, trimmed)
  }

  // 消费引擎事件流：转 RoomEvent 广播 + 路径围栏 + 看门狗 + 失败兜底（§6.2/§6.6/§11.2/§14.5）。
  // 返回 { text, error }：error 非空表示本回合出过故障（供 §14.3 重试/报警判定）。
  private async consumeSeatEventsOnce(
    rt: RoomRuntime,
    seat: Seat,
    sr: SeatRuntime,
    payload: AiSendPayload
  ): Promise<{ text: string; error?: { code: AgentErrorCode; message: string; retryable: boolean } }> {
    let finalText = ''
    let timedOut = false
    let streamError: { code: AgentErrorCode; message: string; retryable: boolean } | undefined
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const resetWatchdog = (): void => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        timedOut = true
        try { sr.engine.cancel(payload.sessionId) } catch { /* 熔断失败不阻塞 */ }
      }, SEAT_TURN_TIMEOUT_MS)
    }
    try {
      resetWatchdog()
      for await (const ev of sr.engine.submitTurn(payload)) {
        resetWatchdog()
        if (ev.type === 'text_delta') finalText += ev.content
        else if (ev.type === 'turn_end') {
          const u = ev.usage
          const t = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0)
          sr.tokensUsed += u?.inputTokens ?? 0
          sr.signals.tokens += t
        } else if (ev.type === 'error') {
          streamError = { code: ev.code, message: ev.message, retryable: ev.retryable && isRetryableCode(ev.code) }
        }
        this.handleSeatEvent(rt, seat, sr, ev)
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      streamError = { code: 'unknown', message: detail, retryable: false }
    } finally {
      if (watchdog) clearTimeout(watchdog)
    }
    if (timedOut) {
      // 看门狗熔断（§14.5）：当作可重试一次的「疑似卡死」。
      streamError = { code: 'provider_timeout', message: '疑似卡死，已强制中止本回合', retryable: true }
    }
    return { text: finalText, error: streamError }
  }

  // 带自动重试 + 报警的回合消费（§14.3）。可重试故障指数退避重试，最终失败 → 暂停岗位 + 报警。
  private async consumeSeatEvents(
    rt: RoomRuntime,
    seat: Seat,
    sr: SeatRuntime,
    payload0: AiSendPayload
  ): Promise<string> {
    const MAX_RETRIES = 2
    let attempt = 0
    let payload = payload0
    while (true) {
      const { text, error } = await this.consumeSeatEventsOnce(rt, seat, sr, payload)
      if (!error) {
        sr.lastError = undefined
        return text
      }
      sr.signals.errors++
      if (error.retryable && attempt < MAX_RETRIES) {
        attempt++
        // 重试中：人话提示（不升级为报警），指数退避。
        this.systemNote(rt.room.id, explainError(error.code, seat.name, true))
        if (rt.weixinRelay) void notifyWeixin(explainError(error.code, seat.name, true))
        await delay(Math.min(8000, 1000 * 2 ** attempt))
        // 换新 turnId 重跑，避免审计/调试事件复用同一 turnId 产生重复记录（B1-2）。
        payload = { ...payload, turnId: randomUUID() }
        continue
      }
      // 不可重试 / 重试耗尽 → 真卡死：摘除岗位 + 报警（§14.3/§14.4）。
      // 用 erroredSeats（非 pausedSeats）：新一轮用户发言会清空它，给岗位重试机会，
      // 而手动暂停（pausedSeats）则持久保留，语义清晰区分。
      sr.state = 'error'
      sr.lastError = { code: error.code, message: error.message }
      sr.failures.push(`[报错] ${error.code}：${error.message}`)
      rt.erroredSeats.add(seat.id) // 从调度摘除，其他岗位照常
      const human = explainError(error.code, seat.name, false)
      this.systemNote(rt.room.id, human)
      if (rt.weixinRelay) void notifyWeixin(human)
      return text
    }
  }

  // 单个引擎事件的处理：广播 + 交互类分流 + 路径围栏（§6.6/§7.4）。
  private handleSeatEvent(rt: RoomRuntime, seat: Seat, sr: SeatRuntime, ev: AgentEvent): void {
    const roomId = rt.room.id
    // §6.6 权限自动裁决：permission_request（终端命令/敏感写）先按路径围栏判定，
    // 工作区内的安全操作自动放行，越界/危险才升级为审批横幅，避免岗位每条命令都打断用户。
    if (ev.type === 'permission_request') {
      const verdict = this.autoResolvePermission(seat, ev)
      if (verdict !== 'ask') {
        sr.engine.resolvePermission(ev.requestId, verdict === 'allow' ? 'allow_once' : 'deny')
        if (verdict === 'deny') {
          sr.signals.outOfBounds++
          const where = ev.details?.path ?? ev.details?.command ?? ev.summary
          sr.failures.push(`[越界] 试图操作 ${where} → 只动自己 seats/ 内`)
          this.systemNote(roomId, `岗位「${seat.name}」请求越界/危险操作（${where}），已自动拒绝。`)
          rt.noProgressStreak++
        }
        // 已自动裁决，仍广播为非交互过程事件供 UI 折叠显示，但不挂起全群。
        this.broadcast(roomId, seat.id, ev, false, sr.privateReplyVisibility)
        return
      }
    }
    // 第二类「需要你回应」事件：强制弹横幅 + 标 interactive（§7.4）。
    const interactive = ev.type === 'permission_request' || ev.type === 'user_question'
    if (interactive) sr.state = 'waiting-user'
    if (ev.type === 'user_question') sr.signals.questions++
    // §14.2 监工：从事件流顺手聚合「当前步骤」（无需新埋点）。
    if (ev.type === 'tool_call_start') {
      sr.currentStep = `调用 ${ev.name}`
    } else if (ev.type === 'task_list_updated') {
      const active = ev.tasks.find((t) => t.status === 'in_progress')
      if (active) sr.currentStep = active.activeForm || active.subject
    }
    this.broadcast(roomId, seat.id, ev, interactive, sr.privateReplyVisibility)

    // 微信遥控：交互类事件经主管汇总推机主（host-merge 队列，§8.4）。
    if (rt.weixinRelay && ev.type === 'user_question') {
      this.enqueueRelay(rt, { seatId: seat.id, seatName: seat.name, kind: 'question', requestId: ev.requestId, text: ev.question, suggestions: ev.suggestions })
    } else if (rt.weixinRelay && ev.type === 'permission_request') {
      this.enqueueRelay(rt, { seatId: seat.id, seatName: seat.name, kind: 'permission', requestId: ev.requestId, text: ev.summary })
    }

    // 写类工具的 file_change_proposed：自由放行策略——仅密钥/系统目录红线拒绝，其余（含工作区外）放行。
    if (ev.type === 'file_change_proposed') {
      if (this.crossesRedline(seat, ev.path)) {
        sr.engine.resolveFileChange(ev.changeId, 'reject')
        sr.signals.outOfBounds++
        sr.failures.push(`[红线] 试图写敏感/系统路径 ${ev.path} → 已拦截`)
        this.systemNote(roomId, `岗位「${seat.name}」尝试写入密钥/系统路径 ${ev.path}，已拦截（红线，任何岗位都不允许）。`)
        rt.noProgressStreak++
      } else {
        if (sr.writtenPaths.has(ev.path)) {
          sr.signals.reworks++
          sr.failures.push(`[返工] 反复修改 ${ev.path} → 动手前先想清楚改动`)
        } else {
          sr.writtenPaths.add(ev.path)
        }
        sr.engine.resolveFileChange(ev.changeId, 'accept')
      }
    }
  }

  // 决定下一个发言者，按 speakingPolicy 分派（§6.3）。
  private resolveNextSpeaker(rt: RoomRuntime, seat: Seat, finalText: string): Seat | null {
    switch (rt.room.speakingPolicy) {
      case 'round-robin':
        return this.nextRoundRobin(rt, seat)
      case 'free':
        return this.nextFree(rt, seat, finalText)
      case 'host-routed':
      default:
        return this.nextHostRouted(rt, seat)
    }
  }

  // 岗位是否当前不可调度：手动暂停 或 报错摘除。两者都暂时排除出发言轮转。
  private isUnavailable(rt: RoomRuntime, seatId: string): boolean {
    return rt.pausedSeats.has(seatId) || rt.erroredSeats.has(seatId)
  }

  // host-routed（首版默认）：host 用 mention_seat/private_message 批量 @ 岗位，依次排空队列；
  // 工人发言完，若队列还有人则继续派下一个（同一批），否则回主管收口。
  // 批量派发支撑「主管一回合给多个岗位分别派活，依次执行后统一收口」（增强①）。
  private nextHostRouted(rt: RoomRuntime, seat: Seat): Seat | null {
    // host 回合结束：开始排空本回合积累的派发队列。
    // 工人回合结束：若队列仍有人（同一批未派完），继续派下一个；否则回主管。
    const next = this.dequeueMention(rt)
    if (next) return next
    if (seat.isHost) return null
    return rt.room.seats.find((s) => s.id === rt.room.hostSeatId) ?? null
  }

  // 从派发队列取下一个有效目标，把交代任务写进消息流（私信带 visibility 白名单）。
  // 队列归主管所有 → 任务消息恒以主管为 from（不随排空时正在收尾的工人漂移）。
  // 跳过无效/禁用/不可调度的目标，直到取到一个或队列空。
  private dequeueMention(rt: RoomRuntime): Seat | null {
    const hostId = rt.room.hostSeatId
    while (rt.mentionQueue.length > 0) {
      const m = rt.mentionQueue.shift()!
      const target = rt.room.seats.find((s) => s.id === m.seatId)
      if (!target || !target.enabled || this.isUnavailable(rt, target.id) || target.id === hostId) continue
      // 任务作为定向消息进消息流；私信（private）带 visibility 白名单，仅主管+目标可见。
      if (m.task && m.task.trim()) {
        const u = appendUtterance(rt.room.id, {
          from: hostId,
          to: target.id,
          text: m.task.trim(),
          ...(m.private ? { visibility: [hostId, target.id] } : {})
        })
        // 实时广播给前端，否则这条定向/私信消息要等重进群才从历史加载（私聊框收不到对方消息）。
        sendToRenderer('room:utterance', { roomId: rt.room.id, utterance: u })
      }
      // 私密派活：标记目标本回合为「私密回合」，其最终发言也只回给主管+自己（不进公屏）。
      // 公开派活：清除可能残留的私密标记，回归正常公开发言。
      // 用 getSeatRuntime 确保运行态存在（目标可能从未发言、尚无 runtime）。
      const sr = this.getSeatRuntime(rt, target)
      sr.privateReplyVisibility = m.private ? [hostId, target.id] : undefined
      sr.privateReplySource = m.private ? 'host' : undefined
      return target
    }
    return null
  }

  // round-robin：按固定顺序在「启用的工人岗位」间轮转；转完一圈回主管收口一次。
  // 用「完整工人顺序」定位当前岗位再向后找下一个未暂停者，避免中途暂停导致 filter 下标偏移（B4-2）。
  private nextRoundRobin(rt: RoomRuntime, seat: Seat): Seat | null {
    const order = rt.room.seats.filter((s) => !s.isHost && s.enabled)
    const active = order.filter((s) => !this.isUnavailable(rt, s.id))
    if (active.length === 0) return null
    const host = rt.room.seats.find((s) => s.id === rt.room.hostSeatId) ?? null
    if (seat.isHost) {
      // 收口回合（一圈已结束）→ 不再起新一圈，结束等用户。
      if (rt.rrClosing) { rt.rrClosing = false; return null }
      return active[0]
    }
    // 在完整顺序里定位当前岗位，向后找第一个未暂停的工人。
    const curPos = order.findIndex((s) => s.id === seat.id)
    for (let i = curPos + 1; i < order.length; i++) {
      if (!this.isUnavailable(rt, order[i].id)) return order[i]
    }
    // 已到队尾 → 回主管收口（一圈结束）。
    rt.rrClosing = true
    return host
  }

  // free：每个岗位发言末尾可声明 @某人 接力；无人 @ 则结束（§6.3）。
  private nextFree(rt: RoomRuntime, seat: Seat, finalText: string): Seat | null {
    const mentioned = this.parseMention(rt, finalText, seat.id)
    if (mentioned) return mentioned
    // 无显式接力：工人岗位默认回主管一次（避免直接静默），主管不接则结束。
    if (!seat.isHost) return rt.room.seats.find((s) => s.id === rt.room.hostSeatId) ?? null
    return null
  }

  // 从发言文本里解析 @岗位名（free 模式接力）。排除 @ 自己，仅匹配启用岗位。
  private parseMention(rt: RoomRuntime, text: string, selfId: string): Seat | null {
    if (!text) return null
    for (const s of rt.room.seats) {
      if (s.id === selfId || !s.enabled || this.isUnavailable(rt, s.id)) continue
      // 匹配 @名字 或 @id（名字优先，宽松匹配中文/英文）。
      const re = new RegExp(`@\\s*(${escapeRegExp(s.name)}|${escapeRegExp(s.id)})`)
      if (re.test(text)) return s
    }
    return null
  }

  // 用户中断（room:stop，§6.4）：cancel 当前岗位引擎，清空待发言队列与微信遥控队列。
  stop(roomId: string): void {
    const rt = this.runtimes.get(roomId)
    if (!rt) return
    rt.abort?.abort()
    rt.mentionQueue = []
    rt.pendingUserInputs = []
    // 并行模型：置 stopping 闸门（阻止 pumpHost/spawnWorker 再起新回合），清空待办/等位，
    // 并即时清空在跑/待办计数。各工人引擎下面统一 cancel。下条用户消息会复位 stopping。
    rt.stopping = true
    rt.schedEpoch++ // 世代+1：在途后台任务完工时据此判定自己已过期，丢弃交付/唤醒
    rt.hostQueue = []
    rt.hostBusy = false
    rt.workerWaitQueue = []
    rt.activeWorkers.clear()
    rt.dispatchCount = 0
    rt.hostEmptyStreak = 0
    // 中断不是正常收敛：抑制后续在途工人 finally 里 recomputeRunning 误推「✓ 完成」微信通知。
    rt.idleNotified = true
    // 中断 = 用户主动停下，本轮视为「已结束」，清掉未完成标记（不是半途崩溃需恢复）。
    if (rt.room.interrupted) updateRoom(rt.room.id, { interrupted: false })
    // 清微信遥控的挂起交互项：中断后这些 requestId 对应的引擎已被 cancel，
    // 不清的话机主下一条微信会被误当成对「已失效提问/审批」的回答而被静默吞掉。
    rt.activeRelay = null
    rt.relayQueue = []
    for (const sr of rt.seats.values()) {
      try { sr.engine.cancel() } catch { /* ignore */ }
      if (sr.state === 'working' || sr.state === 'waiting-user') sr.state = 'idle'
    }
    this.broadcastRunning(roomId, false)
  }

  // 解散群聊（§11.7 扩展）：停掉运行态、丢弃 runtime、回收记忆、物理删除磁盘数据。不可逆。
  disband(roomId: string): boolean {
    this.stop(roomId)
    const rt = this.runtimes.get(roomId)
    // 删盘前先回收各岗位的会话记忆 + 项目记忆（落在 userData/memory，不在 rooms/ 下，deleteRoom 删不到）。
    const room = getRoom(roomId)
    if (room) {
      for (const seat of room.seats) {
        const sessionId = `room:${roomId}:seat:${seat.id}`
        // 回收 worktree 隔离副本：它建在用户项目的 .codelf/worktrees/ 下，deleteRoom（删 rooms/）够不到，
        // 不清会在用户仓库里永久残留 worktree 目录 + codelf-worktree-* 分支，越积越多。
        if (rt?.seats.get(seat.id)?.worktreeRoot) {
          try { exitWorktreeSession({ sessionId, remove: true }) } catch { /* 回收失败不阻塞解散 */ }
        }
        // 微信同源主管：其项目记忆 = 微信工作区记忆，不能删（与微信 agent 共享）；只清会话级数据。
        const sharesWeixin = !!seat.isHost && !!room.weixinBinding
        void purgeSessionAndProjectMemory({
          sessionId,
          workspaceRoot: sharesWeixin ? null : seat.workspaceRoot
        })
      }
    }
    this.runtimes.delete(roomId)
    return deleteRoom(roomId)
  }
  getSeatStatuses(roomId: string): Array<{ seatId: string; state: SeatState; tokensUsed: number; paused: boolean }> {
    const rt = this.runtimes.get(roomId)
    if (!rt) return []
    // 以配置里的全部岗位为准遍历（rt.seats 是懒加载，从没发言的岗位不在其中）。
    // 否则暂停一个「空闲/没开工」的岗位时，状态查询里没有这条，前端拿不到 paused，UI 无反应。
    return rt.room.seats.map((seat) => {
      const sr = rt.seats.get(seat.id)
      const paused = rt.pausedSeats.has(seat.id)
      const errored = rt.erroredSeats.has(seat.id)
      const state: SeatState = paused ? 'paused' : errored ? 'error' : sr?.state ?? 'idle'
      return { seatId: seat.id, state, tokensUsed: sr?.tokensUsed ?? 0, paused }
    })
  }

  // §14.2 监工：把各岗位进度聚合成人话（room_status 工具调用后由主管转述）。
  describeProgress(roomId: string): string {
    const rt = this.runtimes.get(roomId)
    if (!rt) return '群不存在或未初始化。'
    const lines: string[] = []
    for (const seat of rt.room.seats) {
      if (seat.isHost) continue
      const sr = rt.seats.get(seat.id)
      if (!sr) { lines.push(`- ${seat.name}：未开工`); continue }
      const stateLabel: Record<SeatState, string> = {
        idle: '空闲', working: '工作中', 'waiting-user': '等回复', paused: '已暂停', error: '出错', done: '完成'
      }
      const parts = [stateLabel[sr.state] ?? sr.state]
      if (sr.currentStep && sr.state === 'working') parts.push(`正在：${sr.currentStep}`)
      if (sr.lastError) parts.push(`故障：${sr.lastError.message}`)
      if (sr.tokensUsed) parts.push(`约 ${formatTokens(sr.tokensUsed)} token`)
      lines.push(`- ${seat.name}：${parts.join('，')}`)
    }
    return lines.length ? ['各岗位进度：', ...lines].join('\n') : '还没有岗位开工。'
  }

  // ===== 主管考核回合（§12.6 定期结算）=====
  // 对全体已激活岗位打分 → 落 KPI 记录 → 写绩效档案+错题本进各自记忆 → 清零信号进入下周期。
  // 返回团队战报文本（供周报投递/UI）。best-effort，失败不抛。
  async runReviewCycle(roomId: string, period?: string): Promise<string> {
    const rt = this.getRuntime(roomId)
    if (!rt) return ''
    const pd = period || weekPeriod()
    const inputs: SeatReviewInput[] = []
    // 只考核「有运行态」（本周期实际参与过）的启用岗位。
    for (const seat of rt.room.seats) {
      if (!seat.enabled) continue
      const sr = rt.seats.get(seat.id)
      if (!sr) continue
      const eff = this.resolveEffectiveSeat(rt, seat)
      inputs.push({
        seatId: seat.id,
        seatName: seat.name,
        role: seat.role,
        signals: { ...sr.signals },
        digest: this.seatDigest(rt, seat.id),
        failures: [...sr.failures],
        workspaceRoot: eff.workspaceRoot
      })
    }
    if (inputs.length === 0) return '本周期无岗位参与，跳过考核。'

    const scores = await scoreSeats(inputs, pd)
    const reportLines: string[] = [`团队战报 · ${pd}`, '']
    for (const input of inputs) {
      const sc = scores.find((s) => s.seatId === input.seatId)
      if (!sc) continue
      const rec: SeatKpiRecord = {
        seatId: input.seatId,
        period: pd,
        kpi: sc.kpi,
        dimensions: sc.dimensions,
        highlights: sc.highlights,
        improvements: sc.improvements,
        comment: sc.comment,
        signals: input.signals,
        scoredAt: Date.now()
      }
      appendKpiRecord(roomId, rec)
      // 趋势：与上一条历史比较。
      const hist = readKpiHistory(roomId, input.seatId)
      const prev = hist.length >= 2 ? hist[hist.length - 2] : null
      const trend = prev ? (rec.kpi > prev.kpi ? '上升' : rec.kpi < prev.kpi ? '下降' : '持平') : '首次评定'
      const perf = renderPerfSection(rec, trend)
      const mistakes = renderMistakeEntries(input.failures)
      await writeSeatMemory(input.workspaceRoot, perf, mistakes)
      reportLines.push(`• ${input.seatName}：KPI ${rec.kpi}（${trend}）— ${rec.comment}`)
      // 清零，进入下个周期。
      const sr = rt.seats.get(input.seatId)
      if (sr) { sr.signals = freshSignals(); sr.failures = []; sr.writtenPaths.clear() }
    }
    const report = reportLines.join('\n')
    this.systemNote(roomId, report)
    if (rt.weixinRelay) void notifyWeixin(report)
    return report
  }

  // 取某岗位本周期发言摘要（最近若干条，喂主管打分）。
  private seatDigest(rt: RoomRuntime, seatId: string): string {
    const msgs = getTranscript(rt.room.id).filter((u) => u.from === seatId)
    const recent = msgs.slice(-5).map((u) => u.text)
    const joined = recent.join(' / ')
    return joined.length > 600 ? joined.slice(0, 600) + '…' : joined
  }

  // 读全群最新 KPI（仪表盘用）。
  getLatestKpis(roomId: string): SeatKpiRecord[] {
    const rt = this.getRuntime(roomId)
    if (!rt) return []
    const out: SeatKpiRecord[] = []
    for (const seat of rt.room.seats) {
      const hist = readKpiHistory(roomId, seat.id)
      if (hist.length) out.push(hist[hist.length - 1])
    }
    return out
  }

  // 读某岗位 KPI 历史（曲线用）。
  getKpiHistory(roomId: string, seatId: string): SeatKpiRecord[] {
    return readKpiHistory(roomId, seatId)
  }

  // 读某岗位记忆全文（错题本/经验本/绩效档案查看用，§13.7 / B5-2）。
  async getSeatMemory(roomId: string, seatId: string): Promise<string> {
    const rt = this.getRuntime(roomId)
    if (!rt) return ''
    const seat = rt.room.seats.find((s) => s.id === seatId)
    if (!seat) return ''
    const eff = this.resolveEffectiveSeat(rt, seat)
    if (!eff.workspaceRoot) return ''
    return (await readProjectMemoryContent(eff.workspaceRoot)) ?? ''
  }

  // 覆盖写某岗位记忆全文（UI 手动编辑/删除错题，§13.7 / B5-2）。
  async saveSeatMemory(roomId: string, seatId: string, content: string): Promise<boolean> {
    const rt = this.getRuntime(roomId)
    if (!rt) return false
    const seat = rt.room.seats.find((s) => s.id === seatId)
    if (!seat) return false
    const eff = this.resolveEffectiveSeat(rt, seat)
    if (!eff.workspaceRoot) return false
    await ensureProjectMemory(eff.workspaceRoot)
    const r = await writeProjectMemoryContent(eff.workspaceRoot, content)
    return r.ok
  }

  // 人工校准（§12.7）：用户覆盖某岗位 KPI/评语，追加一条带「人工」标记的记录。
  async calibrateKpi(roomId: string, seatId: string, patch: { kpi?: number; comment?: string }): Promise<void> {
    const hist = readKpiHistory(roomId, seatId)
    const last = hist[hist.length - 1]
    const rt = this.getRuntime(roomId)
    const seat = rt?.room.seats.find((s) => s.id === seatId)
    const rec: SeatKpiRecord = {
      seatId,
      period: last?.period ?? weekPeriod(),
      kpi: patch.kpi ?? last?.kpi ?? 70,
      dimensions: last?.dimensions ?? {},
      highlights: last?.highlights ?? [],
      improvements: last?.improvements ?? [],
      comment: patch.comment ?? last?.comment ?? '',
      signals: last?.signals ?? freshSignals(),
      scoredAt: Date.now()
    }
    appendKpiRecord(roomId, rec)
    if (rt && seat) {
      const eff = this.resolveEffectiveSeat(rt, seat)
      // 人工校准只更新绩效档案，不推进错题本老化（aging=false，避免干扰毕业节奏，§B5-3）。
      await writeSeatMemory(eff.workspaceRoot, renderPerfSection(rec, '人工校准'), [], false)
    }
  }

  // 暂停某岗位：不再参与调度（§7.2）。正在发言的岗位会被 cancel。
  pauseSeat(roomId: string, seatId: string): void {
    const rt = this.getRuntime(roomId)
    if (!rt) return
    rt.pausedSeats.add(seatId)
    // 并行模型：从等位队列摘除（避免之后被 fillWorkerSlots 误起）；正在跑的实例由 cancel 收尾，
    // isUnavailable 会在其完工补位时挡住重启。activeWorkers 由该实例 finally 自行 delete。
    rt.workerWaitQueue = rt.workerWaitQueue.filter((id) => id !== seatId)
    const sr = rt.seats.get(seatId)
    if (sr) {
      try { sr.engine.cancel() } catch { /* ignore */ }
      sr.state = 'paused'
    }
    this.recomputeRunning(rt)
  }

  // 恢复某岗位：重新可被调度。
  resumeSeat(roomId: string, seatId: string): void {
    const rt = this.getRuntime(roomId)
    if (!rt) return
    rt.pausedSeats.delete(seatId)
    const sr = rt.seats.get(seatId)
    if (sr && sr.state === 'paused') sr.state = 'idle'
  }

  // 踢出岗位：软删（enabled=false，§11.7 默认软删保留数据），并暂停其运行态。
  kickSeat(roomId: string, seatId: string): void {
    const room = getRoom(roomId)
    if (!room || seatId === room.hostSeatId) return // 不能踢主管
    updateSeat(roomId, seatId, { enabled: false })
    this.pauseSeat(roomId, seatId)
    const rt = this.getRuntime(roomId)
    if (rt) rt.room = getRoom(roomId) ?? rt.room // 刷新内存快照
  }

  // 建群后追加岗位（U4），并刷新内存快照。返回新群快照。
  addSeat(roomId: string, draft: Parameters<typeof addSeat>[1]): Room | null {
    const room = addSeat(roomId, draft)
    const rt = this.getRuntime(roomId)
    if (rt && room) rt.room = room
    return room
  }

  // 编辑已有岗位（U4：改名字/人设/模型/只读等），并刷新内存快照。host 也可改（除 id）。
  editSeat(roomId: string, seatId: string, patch: Partial<Omit<Seat, 'id'>>): Room | null {
    const room = updateSeat(roomId, seatId, patch)
    const rt = this.getRuntime(roomId)
    if (rt && room) {
      rt.room = room
      // 失效缓存的引擎：工具集（readOnly/allowed/denied）与人设在建引擎时定型，
      // 不重建则编辑无效。仅在该岗位空闲时重建，避免打断正在进行的发言。
      const sr = rt.seats.get(seatId)
      const affectsEngine =
        'readOnly' in patch || 'allowedTools' in patch || 'deniedTools' in patch ||
        'personaPrompt' in patch || 'isolateWorktree' in patch || 'modelProfileId' in patch ||
        'dispatchOnly' in patch || 'rawSystemPrompt' in patch
      if (sr && affectsEngine && sr.state !== 'working' && sr.state !== 'waiting-user') {
        try { sr.engine.cancel() } catch { /* ignore */ }
        rt.seats.delete(seatId) // 下次发言时按新配置懒重建
      }
    }
    return room
  }

  // 私聊某岗位（§7.2）：只调度该 seat 发言一回合，不触发连锁。把用户的话作为定向输入。
  // silent：来自 postUserMessage 的「用户 @ 工人」路由，消息已落盘，不重复 append。
  async privateChat(roomId: string, seatId: string, text: string, silent = false): Promise<void> {
    const rt = this.getRuntime(roomId)
    if (!rt) throw new Error(`群不存在：${roomId}`)
    const seat = rt.room.seats.find((s) => s.id === seatId)
    if (!seat) throw new Error(`岗位不存在：${seatId}`)

    // ===== 并行模型：用户私聊工人 = 后台起一个该工人的单回合，不阻塞群主/其他工人 =====
    if (rt.parallelMode) {
      rt.stopping = false
      if (!silent) this.appendUserUtterance(roomId, text, seatId, [seatId])
      const psr = this.getSeatRuntime(rt, seat)
      psr.privateReplyVisibility = [seatId]
      psr.privateReplySource = 'user'
      // 该工人正忙：消息已落 transcript，它当前回合结束后下次被调度即可读到；这里补一个等位补跑。
      if (rt.activeWorkers.has(seat.id) || rt.activeWorkers.size >= MAX_PARALLEL_WORKERS) {
        if (!rt.workerWaitQueue.includes(seat.id)) rt.workerWaitQueue.push(seat.id)
        this.recomputeRunning(rt)
      } else {
        this.spawnWorker(rt, seat)
      }
      return
    }

    // ===== 串行模型：原单回合语义 =====
    if (rt.running) { rt.pendingUserInputs.push({ text, mention: seatId }); return }
    // 用户私聊：消息只对该岗位可见（不进公屏、其他岗位读不到），且该岗位的回复也设为私密。
    this.appendUserUtterance(roomId, text, seatId, [seatId])
    const psr = this.getSeatRuntime(rt, seat)
    psr.privateReplyVisibility = [seatId]
    psr.privateReplySource = 'user'
    rt.running = true
    rt.abort = new AbortController()
    this.broadcastRunning(roomId, true)
    try {
      await this.runSeatTurn(rt, seat) // 单回合，不进 runSpeakingLoop 的连锁
    } finally {
      rt.running = false
      rt.abort = null
      if (rt.pendingUserInputs.length === 0) this.broadcastRunning(roomId, false)
      await this.drainPendingInputs(rt)
    }
  }

  // 解析用户对挂起岗位的回应（提问/审批回填，供 IPC 调用）。
  resolveUserQuestion(roomId: string, seatId: string, requestId: string, answer: string, cancelled = false): void {
    const rt = this.runtimes.get(roomId)
    const sr = rt?.seats.get(seatId)
    sr?.engine.resolveUserQuestion(requestId, { answer, cancelled })
    if (rt) this.clearRelayFor(rt, requestId)
  }

  resolvePermission(roomId: string, seatId: string, requestId: string, allow: boolean): void {
    const rt = this.runtimes.get(roomId)
    const sr = rt?.seats.get(seatId)
    sr?.engine.resolvePermission(requestId, allow ? 'allow_once' : 'deny')
    if (rt) this.clearRelayFor(rt, requestId)
  }

  // 微信绑定发生转移时，在新群打一条系统提示（供 IPC 层在 create/update 绑定后调用）。
  // displaced：因互斥被自动解绑的旧群列表。
  notifyWeixinBindingTransfer(newRoomId: string, displaced: Array<{ id: string; title: string }>): void {
    if (!displaced.length) return
    // 旧群运行态里的微信遥控标志要一并落停，否则它仍会把节点/提问推微信、并占着 roomAwaitingWeixin。
    for (const d of displaced) {
      const rt = this.runtimes.get(d.id)
      if (rt) {
        rt.weixinRelay = false
        rt.activeRelay = null
        rt.relayQueue = []
        this.systemNote(d.id, '本群已与微信解绑（微信已转移到其他群）。仍可在桌面端继续使用。')
      }
    }
    const names = displaced.map((d) => `「${d.title}」`).join('、')
    this.systemNote(newRoomId, `微信遥控已绑定到本群。原绑定的${names}已自动解绑（微信只能同时对接一个群）。`)
  }

  // 桌面端回答了某交互项后，清掉微信遥控队列里对应的同一 requestId，避免它残留导致
  // 「room 仍以为在等微信回应」、且机主下一条微信被误当成对已答项的回复而被吞掉。
  private clearRelayFor(rt: RoomRuntime, requestId: string): void {
    rt.relayQueue = rt.relayQueue.filter((r) => r.requestId !== requestId)
    if (rt.activeRelay?.requestId === requestId) {
      rt.activeRelay = null
      this.pumpRelayQueue(rt)
    }
  }

  // ChannelManager 路由用：找绑定了微信的群（首版单群）。
  findWeixinBoundRoom(): string | null {
    for (const room of listRooms()) {
      if (room.weixinBinding) return room.id
    }
    return null
  }

  // ChannelManager 路由用：是否有群正等机主（微信）回应交互项。
  roomAwaitingWeixin(): string | null {
    for (const [roomId, rt] of this.runtimes) {
      if (rt.weixinRelay && rt.activeRelay) return roomId
    }
    return null
  }
}

export const roomOrchestrator = new RoomOrchestrator()

// 转义正则元字符（free 模式 @ 名字匹配用）。
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 解析微信权限回复（B3-4）：仅明确同意/拒绝才裁决，模糊回复返回 null（不擅自授权）。
function parsePermissionReply(text: string): 'allow_once' | 'deny' | null {
  const t = text.trim().toLowerCase()
  if (/^(同意|允许|批准|可以|approve|allow|yes|y|ok)$/.test(t)) return 'allow_once'
  if (/^(拒绝|不行|不可以|否|deny|no|n|reject)$/.test(t)) return 'deny'
  return null
}

// §6.6 危险命令检测：删除/格式化/权限/管道执行远端脚本等高破坏操作。
// 注意：当前策略为「全放行」，autoResolvePermission 已不再调用本函数（不再弹授权横幅）。
// 导出保留定义，以便日后需要恢复「危险命令交用户拍板」时直接接回。
export function isDangerousCommand(command: string): boolean {
  const c = command.toLowerCase()
  const patterns = [
    /\brm\s+(-[a-z]*\s+)*(-rf|-fr|-r\b|-f\b)/, // rm -rf 等
    /\brmdir\b/, /\bdel\s+\/[sq]/, /\brd\s+\/s/, // 删除目录
    /\bformat\b/, /\bmkfs\b/, /\bdd\s+if=/, // 格式化/磁盘写
    /\b(sudo|su)\b/, /\bchmod\s+-r/, /\bchown\s+-r/, // 提权/批量权限
    />\s*\/dev\/sd/, /\b:\(\)\s*\{.*\}/, // 设备写/fork 炸弹
    /\b(curl|wget|iwr|invoke-webrequest)\b.*\|\s*(sh|bash|pwsh|powershell|python|node)/, // 远端脚本管道执行
    /\bgit\s+push\b.*\s(-f|--force)/, // 强推
    /\bgit\s+push\b/, // 任何 push：推远端是跨机器共享态变更，交用户拍板（工人自动放行口径外）
    /\bgit\s+config\b.*\s(--global|--system)/, // 改全局/系统 git 配置（写 ~/.gitconfig，影响全员）
    /\bnpm\s+publish\b/, /\bshutdown\b/, /\breboot\b/
  ]
  return patterns.some((re) => re.test(c))
}

// 从命令字符串里粗略抽取绝对路径（Windows 盘符 / POSIX 根），用于围栏越界判定。
function absolutePathsIn(command: string): string[] {
  const out: string[] = []
  const win = command.match(/[A-Za-z]:[\\/][^\s"'|&;<>]*/g)
  if (win) out.push(...win)
  const posix = command.match(/(?<![\w.])\/[^\s"'|&;<>]+/g)
  if (posix) out.push(...posix)
  return out
}

// 抽取含父级逃逸（..）的相对路径 token，用于检测 `rm ../other`、`cp x ../../elsewhere` 这类
// 不带绝对路径、也不命中危险模式、却逃出工作区的命令。无 .. 的相对路径解析后仍在围栏内，无需查。
function relativePathsIn(command: string): string[] {
  const matches = command.match(/(?<![\w:])\.\.[\\/][^\s"'|&;<>]*/g)
  return matches ?? []
}

// 初始化一个空信号快照（§12.3）。
function freshSignals(): SeatSignals {
  return { reworks: 0, outOfBounds: 0, questions: 0, errors: 0, completed: false, tokens: 0, durationMs: 0 }
}

// 简易延时（重试退避用）。
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// token 数格式化成人话（1.2万 / 3500）。
function formatTokens(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n)
}

// 当前 ISO 周期标签：'2026-W26'（§12.5）。
function weekPeriod(d = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// 命令执行 cwd 兜底：岗位无工作区（主管/纯对话岗位 = null）时回退到用户家目录，
// 让 PowerShell/terminal 等工具有合法运行根，不再一律「未打开工作区」失败（修复 bug3）。
function safeHomeDir(): string {
  try {
    return homedir() || process.cwd()
  } catch {
    return process.cwd()
  }
}

// 把「未读增量」渲染成岗位本回合的输入文本（§6.2 renderGroupTranscript）。
// 标注「谁 @ 了你、说了什么」，让岗位知道当前任务来源（§5.4.2 第 4 点）。
// isHost：主管的职责是「先理解需求、再用 mention_seat 分派」，而非亲自动手（B1-4 决策）。
// nameOf：把消息里的 seatId 渲染成人话显示名（群主验收时知道是「谁」交付的）。
// parallel：并行模型下，群主的输入可能混着「用户新需求」和「工人完工交付」，给出验收+播报引导。
function renderGroupTranscript(
  incoming: Array<{ from: string; to?: string; text: string; visibility?: string[] }>,
  isHost = false,
  privateReply: false | 'host' | 'user' = false,
  nameOf: (id: string) => string = (id) => id,
  parallel = false
): string {
  // 群主在并行模型下，输入可能含工人交付：判断是否有「工人发来的（非 user/system）」消息。
  const hasWorkerDelivery = isHost && incoming.some((u) => u.from !== 'user' && u.from !== 'system')
  const hostTail = parallel
    ? (hasWorkerDelivery
        ? '上面有岗位完工交付（标注「✅ 完工交付」）。请：① 验收 ta 的成果，必要时打开产物核对质量；② 用人话主动向用户播报这件事完成了、结果如何；③ 再决定下一步（继续派活/等其他人/收尾）。同时若有用户的新消息，一并回应。不要自己动手写代码/改文件。'
        : '请先理解清楚用户的真实需求，再用 mention_seat 把任务分派给最合适的岗位（可一次并行派给多个）；不要自己动手写代码/改文件。若需求模糊，先提问澄清。派完活若无其他事，直接结束发言即可。')
    : '请先理解清楚用户的真实需求，再用 mention_seat 把任务分派给最合适的岗位；不要自己动手写代码/改文件。若需求模糊，先提问澄清。'
  // 私密回合分两种来源：
  // - 'user'：用户直接私聊该岗位，本轮只回给用户（其他岗位/主管不介入），口吻是直接回复用户本人。
  // - 'host'：被主管私信单独叫起，本轮只回给主管，可放心私下汇报。
  const workerTail = privateReply === 'user'
    ? '这是用户私下直接找你单聊：本轮发言只有你和用户能看到，其他岗位和主管都看不到。请以「你自己这个岗位」的身份，直接、清楚地回答用户本人——用户就是发起私聊的人，不是主管，别把 ta 当主管，也别说「汇报给主管」之类的话。'
    : privateReply === 'host'
      ? '你是被主管私信单独叫起的：本轮发言只有主管和你能看到，其他岗位看不到。请直接、私下地把结果/选择回复给主管，不必担心泄露给其他人。'
      : '请基于以上内容，完成属于你职责范围内的事，并在群里简洁汇报结果。'
  const tail = isHost ? hostTail : workerTail
  if (incoming.length === 0) {
    return isHost
      ? '（群里暂无新消息。作为主管，请基于团队职责主动推进或等待用户指令，用 mention_seat 分派而非亲自动手。）'
      : '（群里暂无新消息。如果你是被点名发言，请基于你的职责主动推进；否则简要说明你在等待什么。）'
  }
  const lines = incoming.map((u) => {
    const isWorker = u.from !== 'user' && u.from !== 'system'
    const who = u.from === 'user' ? '用户' : u.from === 'system' ? '系统' : nameOf(u.from)
    const at = u.to ? `（@${nameOf(u.to)}）` : ''
    // 私信标注：让收信岗位知道这是私下交代，其他岗位看不到，回复时不必复述私信内容。
    const priv = u.visibility && u.visibility.length ? '（🔒私信，仅你可见）' : ''
    // 群主视角：工人发来的消息标为「完工交付」，提示该验收+播报。
    const deliver = isHost && isWorker ? '✅ 完工交付 ' : ''
    return `【${deliver}${who}${at}${priv}】：${u.text}`
  })
  return ['以下是群里自你上次发言以来的新消息：', '', ...lines, '', tail].join('\n')
}
