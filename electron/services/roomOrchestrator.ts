import { randomUUID } from 'crypto'
import { resolve, sep, isAbsolute } from 'path'
import { realpathSync } from 'fs'
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
import { createRoomHostTools, type MentionRecord } from '../agent/tools/roomTools'
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

// 一条待机主（微信）回应的交互项（host-merge：串行抛给微信，§8.4）。
interface PendingRelay {
  seatId: string
  seatName: string
  kind: 'question' | 'permission'
  requestId: string
  text: string
  suggestions?: string[]
}

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
}

interface RoomRuntime {
  room: Room
  seats: Map<string, SeatRuntime>   // seatId -> 运行态（懒加载引擎）
  running: boolean                  // 是否有发言循环在跑
  pendingMention: MentionRecord | null  // host 本回合 @ 的岗位
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
      pendingMention: null,
      abort: null,
      noProgressStreak: 0,
      pendingUserInputs: [],
      weixinRelay: false,
      relayQueue: [],
      activeRelay: null,
      roundRobinIdx: 0,
      rrClosing: false,
      pausedSeats: new Set(),
      erroredSeats: new Set()
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
        recordMention: (m) => { rt.pendingMention = m },
        describeProgress: () => this.describeProgress(rt.room.id)
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
  private broadcast(roomId: string, seatId: string, payload: AgentEvent, interactive = false): void {
    const ev: RoomEvent = { roomId, seatId, payload, ...(interactive ? { interactive: true } : {}) }
    sendToRenderer('room:event', ev)
  }

  // 系统提示进 transcript + 广播（岗位失败、软提醒等）。
  private systemNote(roomId: string, text: string): void {
    appendUtterance(roomId, { from: 'system', text })
    sendToRenderer('room:system', { roomId, text })
  }

  // 写入一条用户消息并广播给前端（room:utterance）。桌面发起时前端已乐观插入，
  // 但微信发起的消息前端无从得知 → 必须广播，否则 codelf 界面看不到机主在微信发的话。
  private appendUserUtterance(roomId: string, text: string, to?: string): void {
    const u = appendUtterance(roomId, { from: 'user', text, ...(to ? { to } : {}) })
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

  // §6.6 权限自动裁决（自由放行策略）：岗位可读写工作区以外的任意路径（含用户现有项目），
  // 只保留两道硬红线 + 危险命令把关：
  // - 写类（带 path）：命中密钥文件 / 系统目录 → deny（红线，谁都不能碰）；否则 allow。
  // - 终端命令（带 command）：危险命令 → ask（交用户拍板）；引用密钥/系统路径 → deny；否则 allow。
  // - 相对路径按岗位工作区解析后再判红线（与 resolveAnyPath 同口径）。
  // - 无 details 可判定 → ask（保守）。
  private autoResolvePermission(seat: Seat, ev: Extract<AgentEvent, { type: 'permission_request' }>): 'allow' | 'deny' | 'ask' {
    const d = ev.details
    if (d?.path) {
      return this.crossesRedline(seat, d.path) ? 'deny' : 'allow'
    }
    if (d?.command) {
      if (isDangerousCommand(d.command)) return 'ask'
      if (commandReferencesSensitivePath(d.command)) return 'deny'
      const paths = [...absolutePathsIn(d.command), ...relativePathsIn(d.command)]
      if (paths.some((p) => this.crossesRedline(seat, p))) return 'deny'
      return 'allow'
    }
    return 'ask'
  }

  // 硬红线：密钥文件（secrets）与系统目录，任何岗位都不能写/动。相对路径按岗位工作区解析。
  private crossesRedline(seat: Seat, targetPath: string): boolean {
    const abs = isAbsolute(targetPath)
      ? targetPath
      : (seat.workspaceRoot ? resolve(seat.workspaceRoot, targetPath) : resolve(targetPath))
    return isSensitivePath(abs) || isSystemPath(abs)
  }

  // 路径围栏（§6.6 + §11.8）：目标路径规范化（含 realpath 防符号链接绕过）后，
  // 判断是否落在 seat.workspaceRoot 子树内。在内 → 放行；越界 → 拦截。
  // 关键：相对路径必须按 seat 工作区解析（与 resolveAnyPath 同口径），不能用 process.cwd()，
  // 否则 delete/终端命令带相对路径时围栏判定会落到 app 进程目录，导致误放行或误拦截。
  private isWithinFence(seat: Seat, targetPath: string): boolean {
    if (!seat.workspaceRoot) return false
    const resolvedTarget = isAbsolute(targetPath)
      ? targetPath
      : resolve(seat.workspaceRoot, targetPath)
    const fenceReal = safeRealpath(resolve(seat.workspaceRoot))
    const targetReal = safeRealpath(resolvedTarget)
    const fence = fenceReal.endsWith(sep) ? fenceReal : fenceReal + sep
    return targetReal === fenceReal || targetReal.startsWith(fence)
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
    // 并发输入：循环跑着时排队，结束后再处理（§11.4，绝不并行启两个循环）。
    // 注意：排队也要立刻 append+广播用户消息，否则用户这条话在「上一轮还没跑完」时
    // 发出，会既看不到自己的消息、待 drain 时才补显（顺序也乱）。先落消息流再排队。
    if (rt.running) {
      this.appendUserUtterance(roomId, text, mention)
      rt.pendingUserInputs.push({ text, mention, fromWeixin, alreadyPosted: true })
      return
    }
    // alreadyPosted：drain 时复用本方法但消息早已在入队时落过盘，不重复 append。
    if (!alreadyPosted) this.appendUserUtterance(roomId, text, mention)
    // 决定首个发言者：被 @ 的岗位，否则主 Agent（§6.1）。
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

  // ===== 单个岗位发言一回合（§6.2）=====
  // 返回下一个该发言的岗位（host-routed：host 用 mention_seat 指定；工人岗位默认回主管）。
  private async runSeatTurn(rt: RoomRuntime, seat: Seat): Promise<Seat | null> {
    const sr = this.getSeatRuntime(rt, seat)
    sr.state = 'working'
    sr.turnStartedAt = Date.now()
    rt.pendingMention = null

    // host 同源覆盖（微信人格 + 工作区），工人岗位原样（§8/§11.1）。
    const effSeat0 = this.resolveEffectiveSeat(rt, seat)
    // 写冲突隔离（§9.2）：开关开启且 workspaceRoot 是 git 仓 → 切到独立 worktree 副本。
    const effSeat = this.ensureSeatWorktree(rt, seat, effSeat0)
    const sessionId = `room:${rt.room.id}:seat:${seat.id}`
    const incoming = collectUnseenFor(rt.room.id, seat.id)
    const prompt = renderGroupTranscript(incoming, !!seat.isHost)

    const payload: AiSendPayload = {
      sessionId,
      turnId: randomUUID(),
      message: prompt,
      sessionCwd: effSeat.workspaceRoot,
      // 每岗位模型：用 seat.modelProfileId（不设则引擎回退到全局激活 profile）。
      ...(seat.modelProfileId ? { profileId: seat.modelProfileId } : {}),
      // 记忆绑定基础工作区（worktree 隔离前），不随临时副本漂移 → KPI/注入/UI 三处同源（§9.2 决策）。
      memoryWorkspaceRoot: effSeat0.workspaceRoot,
      // 用 default 模式：写操作走 file_change_proposed 事件，由编排器做路径围栏判定（§6.6）。
      permissionMode: 'default',
      roomContext: this.buildRoomContext(rt, effSeat)
    }

    const finalText = await this.consumeSeatEvents(rt, effSeat, sr, payload)
    markSeen(rt.room.id, seat.id)
    sr.signals.durationMs += Date.now() - sr.turnStartedAt
    // 空发言不写 transcript（§11.6）；非空才进事实源。
    const trimmed = finalText.trim()
    if (trimmed) {
      appendUtterance(rt.room.id, { from: seat.id, text: trimmed })
      rt.noProgressStreak = 0
      sr.signals.completed = true
    } else {
      rt.noProgressStreak++
    }
    sr.state = (sr.state as SeatState) === 'error' ? 'error' : 'idle'
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
        this.broadcast(roomId, seat.id, ev, false)
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
    this.broadcast(roomId, seat.id, ev, interactive)

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

  // host-routed（首版默认）：host 用 mention_seat 指定；工人发言完回主管收口。
  private nextHostRouted(rt: RoomRuntime, seat: Seat): Seat | null {
    if (seat.isHost) {
      const m = rt.pendingMention
      rt.pendingMention = null
      if (!m) return null
      const target = rt.room.seats.find((s) => s.id === m.seatId)
      if (!target || !target.enabled || this.isUnavailable(rt, target.id)) return null
      // 把主管经 mention_seat 交代的任务作为定向消息写进消息流，否则 task 丢失、岗位只能看到
      // 主管的群发言、收不到具体指派（含「项目目录在哪」这类关键交代）。
      if (m.task && m.task.trim()) {
        appendUtterance(rt.room.id, { from: seat.id, to: target.id, text: m.task.trim() })
      }
      return target
    }
    return rt.room.seats.find((s) => s.id === rt.room.hostSeatId) ?? null
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
    rt.pendingMention = null
    rt.pendingUserInputs = []
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
    const sr = rt.seats.get(seatId)
    if (sr) {
      try { sr.engine.cancel() } catch { /* ignore */ }
      sr.state = 'paused'
    }
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
        'personaPrompt' in patch || 'isolateWorktree' in patch || 'modelProfileId' in patch
      if (sr && affectsEngine && sr.state !== 'working' && sr.state !== 'waiting-user') {
        try { sr.engine.cancel() } catch { /* ignore */ }
        rt.seats.delete(seatId) // 下次发言时按新配置懒重建
      }
    }
    return room
  }

  // 私聊某岗位（§7.2）：只调度该 seat 发言一回合，不触发连锁。把用户的话作为定向输入。
  async privateChat(roomId: string, seatId: string, text: string): Promise<void> {
    const rt = this.getRuntime(roomId)
    if (!rt) throw new Error(`群不存在：${roomId}`)
    const seat = rt.room.seats.find((s) => s.id === seatId)
    if (!seat) throw new Error(`岗位不存在：${seatId}`)
    if (rt.running) { rt.pendingUserInputs.push({ text, mention: seatId }); return }
    this.appendUserUtterance(roomId, text, seatId)
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

// §6.6 危险命令检测：删除/格式化/权限/管道执行远端脚本等高破坏操作 → 交用户把关。
function isDangerousCommand(command: string): boolean {
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

// realpath 解析真实路径防符号链接绕过（§11.8）；路径不存在时退回 resolve 结果。
function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// 把「未读增量」渲染成岗位本回合的输入文本（§6.2 renderGroupTranscript）。
// 标注「谁 @ 了你、说了什么」，让岗位知道当前任务来源（§5.4.2 第 4 点）。
// isHost：主管的职责是「先理解需求、再用 mention_seat 分派」，而非亲自动手（B1-4 决策）。
function renderGroupTranscript(
  incoming: Array<{ from: string; to?: string; text: string }>,
  isHost = false
): string {
  const hostTail = '请先理解清楚用户的真实需求，再用 mention_seat 把任务分派给最合适的岗位；不要自己动手写代码/改文件。若需求模糊，先提问澄清。'
  const workerTail = '请基于以上内容，完成属于你职责范围内的事，并在群里简洁汇报结果。'
  const tail = isHost ? hostTail : workerTail
  if (incoming.length === 0) {
    return isHost
      ? '（群里暂无新消息。作为主管，请基于团队职责主动推进或等待用户指令，用 mention_seat 分派而非亲自动手。）'
      : '（群里暂无新消息。如果你是被点名发言，请基于你的职责主动推进；否则简要说明你在等待什么。）'
  }
  const lines = incoming.map((u) => {
    const who = u.from === 'user' ? '用户' : u.from === 'system' ? '系统' : u.from
    const at = u.to ? `（@${u.to}）` : ''
    return `【${who}${at}】：${u.text}`
  })
  return ['以下是群里自你上次发言以来的新消息：', '', ...lines, '', tail].join('\n')
}
