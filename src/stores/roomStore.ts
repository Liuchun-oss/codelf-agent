import { create } from 'zustand'
import type { AgentEvent } from '@shared/agentTypes'
import type { Room, RoomEvent, Utterance } from '@shared/roomTypes'

// 群聊前端 store。共享消息流是群级的（§7.3）：所有岗位发言、用户消息、系统提示进同一个
// messages 数组；岗位本回合的流式输出折叠进一个「岗位气泡」，过程默认折叠只显示结果（§7.4）。
//
// 与 agentStore 解耦：群聊不共用 agentStore（§3.1），独立 store + 独立渲染。

// 岗位气泡里的一条工具活动（极简显示：只摘要，不展开除非用户点）。
export interface ToolActivity {
  callId: string
  name: string
  status: 'running' | 'done' | 'error'
  summary: string
  // 完整入参（格式化后的字符串），用于鼠标悬浮在工具行上时展示。
  argsText?: string
}

// 交互类挂起项（提问/审批，§7.4 第二类事件）。
export interface InteractivePrompt {
  kind: 'question' | 'permission'
  requestId: string
  seatId: string
  text: string
  suggestions?: string[]
}

// 群消息流里的一条消息视图。
export interface RoomMessageView {
  id: string
  // 'user' | 'system' | seatId
  from: string
  // 定向接收方（私聊用：用户→某岗位的定向消息带上 seatId，§U1）
  to?: string
  // 私信可见性白名单（主管私信工人）：非空表示这是私信，UI 标注「🔒 私信」。
  visibility?: string[]
  seatName?: string
  // 最终交付文本（流式累积）。
  text: string
  // 本回合的过程活动（折叠区）。
  activities: ToolActivity[]
  // 思考流（折叠）。
  thinking?: string
  streaming?: boolean
  ts: number
}

export interface SeatRuntimeView {
  state: string
  tokensUsed: number
  paused?: boolean
}

interface RoomState {
  rooms: Room[]
  currentRoomId: string | null
  // roomId -> 共享消息流
  messages: Record<string, RoomMessageView[]>
  // roomId -> seatId -> 运行态
  seatRuntime: Record<string, Record<string, SeatRuntimeView>>
  // roomId -> 群级运行态（U6：整轮连锁期间稳定 true，驱动中断按钮）
  roomRunning: Record<string, boolean>
  // roomId -> 当前挂起的交互项（横幅，§7.4）
  pending: Record<string, InteractivePrompt[]>
  loaded: boolean

  load: () => Promise<void>
  createRoom: (draft: import('@shared/roomTypes').RoomDraft) => Promise<Room>
  selectRoom: (roomId: string) => Promise<void>
  deleteRoom: (roomId: string) => Promise<void>
  send: (text: string, mention?: string) => Promise<void>
  privateChat: (seatId: string, text: string) => Promise<void>
  stop: () => Promise<void>
  resolveQuestion: (p: InteractivePrompt, answer: string, cancelled?: boolean) => Promise<void>
  resolvePermission: (p: InteractivePrompt, allow: boolean) => Promise<void>
  applyEvent: (ev: RoomEvent) => void
  applySystem: (payload: { roomId: string; text: string }) => void
  applyRunning: (payload: { roomId: string; running: boolean }) => void
  applyUtterance: (roomId: string, utterance: Utterance) => void
  pauseSeat: (seatId: string) => Promise<void>
  resumeSeat: (seatId: string) => Promise<void>
  kickSeat: (seatId: string) => Promise<void>
  addSeat: (draft: import('@shared/roomTypes').SeatDraft) => Promise<void>
  editSeat: (seatId: string, patch: Partial<Omit<import('@shared/roomTypes').Seat, 'id'>>) => Promise<void>
  refreshStatus: () => Promise<void>
}

let wired = false

// 从 Utterance 历史构建初始消息流（选群时一次性载入）。
function utterancesToMessages(list: Utterance[], room: Room | null): RoomMessageView[] {
  return list.map((u) => ({
    id: `u-${u.seq}`,
    from: u.from,
    seatName: seatNameOf(room, u.from),
    text: u.text,
    activities: [],
    ts: u.ts,
    ...(u.to ? { to: u.to } : {}),
    ...(u.visibility && u.visibility.length ? { visibility: u.visibility } : {})
  }))
}

function seatNameOf(room: Room | null, from: string): string | undefined {
  if (from === 'user') return '我'
  if (from === 'system') return '系统'
  return room?.seats.find((s) => s.id === from)?.name ?? from
}

function summarizeArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  if (typeof args.path === 'string') return args.path
  if (typeof args.command === 'string') return String(args.command).slice(0, 80)
  if (typeof args.query === 'string') return String(args.query).slice(0, 80)
  return ''
}

// 完整入参格式化（用于工具行的悬浮提示 title）。截断到合理长度，避免超长参数撑爆 tooltip。
function formatArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return ''
  try {
    const text = JSON.stringify(args, null, 2)
    return text.length > 2000 ? text.slice(0, 2000) + '\n… (已截断)' : text
  } catch {
    return ''
  }
}

// 把一个岗位的 AgentEvent 折叠进它的「当前回合气泡」。无气泡则新建。
// visibility：私密回合的可见性白名单，新建气泡时打上，使其只进私聊框、不进公屏。
// 返回更新后的消息数组。
function foldSeatEvent(msgs: RoomMessageView[], seatId: string, seatName: string | undefined, ev: AgentEvent, visibility?: string[]): RoomMessageView[] {
  // 找到该岗位最后一条「流式中」的气泡作为当前回合；否则新建。
  let idx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].from === seatId && msgs[i].streaming) { idx = i; break }
  }
  const ensure = (): { list: RoomMessageView[]; i: number } => {
    if (idx >= 0) return { list: msgs, i: idx }
    const fresh: RoomMessageView = {
      id: `m-${seatId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from: seatId, seatName, text: '', activities: [], streaming: true, ts: Date.now(),
      ...(visibility && visibility.length ? { visibility } : {})
    }
    return { list: [...msgs, fresh], i: msgs.length }
  }
  const patch = (i: number, list: RoomMessageView[], next: Partial<RoomMessageView>): RoomMessageView[] =>
    list.map((m, j) => (j === i ? { ...m, ...next } : m))

  switch (ev.type) {
    case 'text_delta': {
      const { list, i } = ensure()
      return patch(i, list, { text: list[i].text + ev.content })
    }
    case 'thinking_delta': {
      const { list, i } = ensure()
      return patch(i, list, { thinking: (list[i].thinking ?? '') + ev.content })
    }
    case 'tool_call_start': {
      const { list, i } = ensure()
      const act: ToolActivity = { callId: ev.callId, name: ev.name, status: 'running', summary: summarizeArgs(ev.args), argsText: formatArgs(ev.args) }
      return patch(i, list, { activities: [...list[i].activities, act] })
    }
    case 'tool_call_result': {
      const { list, i } = ensure()
      const isError = !!(ev.isError || ev.status === 'error')
      return patch(i, list, {
        activities: list[i].activities.map((a) =>
          a.callId === ev.callId ? { ...a, status: isError ? 'error' : 'done' } : a
        )
      })
    }
    case 'turn_end': {
      // 回合结束：该岗位气泡定稿（取消 streaming），下回合会新建气泡。
      if (idx < 0) return msgs
      return patch(idx, msgs, { streaming: false })
    }
    case 'error': {
      // 彻底失败（重试耗尽/无 profile 等）：引擎 yield error 后 return，不发 turn_end。
      // 必须在此给当前流式气泡定稿，否则气泡永久卡在「正在输入…」（B2-2）。
      const { list, i } = ensure()
      const note = `\n\n⚠️ 出错：${ev.message}`
      return patch(i, list, { text: list[i].text + (list[i].text ? note : note.trimStart()), streaming: false })
    }
    default:
      return msgs
  }
}

// 从 AgentEvent 派生岗位运行态（B2-1）：让成员侧栏/中断按钮随发言实时变化，
// 无需后端额外广播，前端从已有事件流派生。返回 null 表示该事件不改变运行态。
// interactive：仅当事件真正需要用户回应（未被后端自动裁决）时，提问/审批才置 waiting-user；
// 自动放行/拒绝的 permission_request（interactive=false）不应让岗位卡在「等你回复」。
function deriveSeatState(ev: AgentEvent, interactive?: boolean): string | null {
  switch (ev.type) {
    case 'turn_start': return 'working'
    case 'user_question':
    case 'permission_request': return interactive ? 'waiting-user' : 'working'
    case 'turn_end': return 'idle'
    case 'error': return 'error'
    default: return null
  }
}


export const useRoomStore = create<RoomState>((set, get) => ({
  rooms: [],
  currentRoomId: null,
  messages: {},
  seatRuntime: {},
  roomRunning: {},
  pending: {},
  loaded: false,

  load: async () => {
    const rooms = await window.lc.room.list()
    set({ rooms, loaded: true })
    if (!wired) {
      wired = true
      window.lc.room.onEvent((ev) => get().applyEvent(ev))
      window.lc.room.onSystem((p) => get().applySystem(p))
      window.lc.room.onRunning((p) => get().applyRunning(p))
      window.lc.room.onUtterance((p) => get().applyUtterance(p.roomId, p.utterance))
    }
  },

  createRoom: async (draft) => {
    const room = await window.lc.room.create(draft)
    set((s) => ({ rooms: upsertRoom(s.rooms, room) }))
    await get().selectRoom(room.id)
    return room
  },

  selectRoom: async (roomId: string) => {
    const room = await window.lc.room.get(roomId)
    set((s) => ({
      currentRoomId: roomId,
      rooms: room ? upsertRoom(s.rooms, room) : s.rooms
    }))
    // 载入历史 transcript 作为初始消息流（仅当本群尚无内存消息时）。
    if (!get().messages[roomId]?.length) {
      const transcript = await window.lc.room.transcript(roomId).catch(() => [])
      set((s) => ({ messages: { ...s.messages, [roomId]: utterancesToMessages(transcript, room) } }))
    }
    const status = await window.lc.room.status(roomId).catch(() => [])
    const runtime: Record<string, SeatRuntimeView> = {}
    for (const st of status) runtime[st.seatId] = { state: st.state, tokensUsed: st.tokensUsed, paused: st.paused }
    set((s) => ({ seatRuntime: { ...s.seatRuntime, [roomId]: runtime } }))
  },

  send: async (text: string, mention?: string) => {
    const roomId = get().currentRoomId
    if (!roomId || !text.trim()) return
    // 乐观插入用户消息（后端也会写 transcript，但前端先显示更跟手）。
    const userMsg: RoomMessageView = {
      id: `user-${Date.now()}`, from: 'user', seatName: '我', text, activities: [], ts: Date.now()
    }
    set((s) => ({ messages: { ...s.messages, [roomId]: [...(s.messages[roomId] ?? []), userMsg] } }))
    await window.lc.room.send(roomId, text, mention)
  },

  privateChat: async (seatId: string, text: string) => {
    const roomId = get().currentRoomId
    if (!roomId || !text.trim()) return
    // 乐观插入带 to + visibility 的定向用户消息：visibility 使其不进公屏、只在该岗位私聊框显示（§U1）。
    const userMsg: RoomMessageView = {
      id: `pm-${Date.now()}`, from: 'user', to: seatId, visibility: [seatId], seatName: '我', text, activities: [], ts: Date.now()
    }
    set((s) => ({ messages: { ...s.messages, [roomId]: [...(s.messages[roomId] ?? []), userMsg] } }))
    await window.lc.room.privateChat(roomId, seatId, text)
  },

  stop: async () => {
    const roomId = get().currentRoomId
    if (roomId) await window.lc.room.stop(roomId)
  },

  deleteRoom: async (roomId: string) => {
    await window.lc.room.delete(roomId)
    set((s) => {
      const rooms = s.rooms.filter((r) => r.id !== roomId)
      const messages = { ...s.messages }; delete messages[roomId]
      const seatRuntime = { ...s.seatRuntime }; delete seatRuntime[roomId]
      const roomRunning = { ...s.roomRunning }; delete roomRunning[roomId]
      const pending = { ...s.pending }; delete pending[roomId]
      const currentRoomId = s.currentRoomId === roomId ? (rooms[0]?.id ?? null) : s.currentRoomId
      return { rooms, messages, seatRuntime, roomRunning, pending, currentRoomId }
    })
    const next = get().currentRoomId
    if (next) await get().selectRoom(next)
  },

  resolveQuestion: async (p, answer, cancelled) => {
    const roomId = get().currentRoomId
    if (!roomId) return
    await window.lc.room.resolveQuestion(roomId, p.seatId, p.requestId, answer, cancelled)
    dismissPending(set, roomId, p.requestId)
  },

  resolvePermission: async (p, allow) => {
    const roomId = get().currentRoomId
    if (!roomId) return
    await window.lc.room.resolvePermission(roomId, p.seatId, p.requestId, allow)
    dismissPending(set, roomId, p.requestId)
  },

  applyEvent: (ev: RoomEvent) => {
    const payload = ev.payload as AgentEvent
    set((s) => {
      const room = s.rooms.find((r) => r.id === ev.roomId) ?? null
      const seatName = seatNameOf(room, ev.seatId)
      const list = s.messages[ev.roomId] ?? []
      const messages = { ...s.messages, [ev.roomId]: foldSeatEvent(list, ev.seatId, seatName, payload, ev.visibility) }
      // 交互类事件升为挂起项（横幅，§7.4）。
      let pending = s.pending
      if (ev.interactive && payload.type === 'user_question') {
        pending = addPending(s.pending, ev.roomId, { kind: 'question', requestId: payload.requestId, seatId: ev.seatId, text: payload.question, suggestions: payload.suggestions })
      } else if (ev.interactive && payload.type === 'permission_request') {
        pending = addPending(s.pending, ev.roomId, { kind: 'permission', requestId: payload.requestId, seatId: ev.seatId, text: payload.summary })
      }
      // 从事件派生岗位运行态，实时驱动成员侧栏/中断按钮（B2-1）。
      let seatRuntime = s.seatRuntime
      const nextState = deriveSeatState(payload, ev.interactive)
      if (nextState && ev.seatId) {
        const roomRuntime = s.seatRuntime[ev.roomId] ?? {}
        const prev = roomRuntime[ev.seatId] ?? { state: 'idle', tokensUsed: 0 }
        // 已暂停的岗位不被事件流改回 working（暂停优先）。
        if (!(prev.paused && nextState === 'working')) {
          seatRuntime = {
            ...s.seatRuntime,
            [ev.roomId]: { ...roomRuntime, [ev.seatId]: { ...prev, state: nextState } }
          }
        }
      }
      return { messages, pending, seatRuntime }
    })
  },

  applySystem: (payload) => {
    set((s) => {
      const list = s.messages[payload.roomId] ?? []
      const msg: RoomMessageView = {
        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        from: 'system', seatName: '系统', text: payload.text, activities: [], ts: Date.now()
      }
      return { messages: { ...s.messages, [payload.roomId]: [...list, msg] } }
    })
  },

  applyRunning: (payload) => {
    set((s) => ({ roomRunning: { ...s.roomRunning, [payload.roomId]: payload.running } }))
  },

  applyUtterance: (roomId, u) => {
    set((s) => {
      const list = s.messages[roomId] ?? []
      const room = s.rooms.find((r) => r.id === roomId) ?? null
      // seq 去重：同一条 utterance（含编排器实时广播的定向/私信消息）只插一次。
      if (list.some((m) => m.id === `evt-${u.seq}`)) return {}
      if (u.from === 'user') {
        // 桌面发起已乐观插入 → 对相同文本/定向的近期用户消息去重，避免重复；微信发起的补显。
        const dup = list.slice(-6).some((m) => m.from === 'user' && m.text === u.text && (m.to ?? undefined) === (u.to ?? undefined))
        if (dup) return {}
      }
      const msg: RoomMessageView = {
        id: `evt-${u.seq}`,
        from: u.from,
        seatName: seatNameOf(room, u.from),
        text: u.text,
        ...(u.to ? { to: u.to } : {}),
        ...(u.visibility && u.visibility.length ? { visibility: u.visibility } : {}),
        activities: [],
        ts: u.ts
      }
      return { messages: { ...s.messages, [roomId]: [...list, msg] } }
    })
  },

  pauseSeat: async (seatId) => {
    const roomId = get().currentRoomId
    if (!roomId) return
    await window.lc.room.pauseSeat(roomId, seatId)
    await get().refreshStatus()
  },

  resumeSeat: async (seatId) => {
    const roomId = get().currentRoomId
    if (!roomId) return
    await window.lc.room.resumeSeat(roomId, seatId)
    await get().refreshStatus()
  },

  kickSeat: async (seatId) => {
    const roomId = get().currentRoomId
    if (!roomId) return
    await window.lc.room.kickSeat(roomId, seatId)
    const room = await window.lc.room.get(roomId)
    set((s) => ({ rooms: room ? upsertRoom(s.rooms, room) : s.rooms }))
    await get().refreshStatus()
  },

  addSeat: async (draft) => {
    const roomId = get().currentRoomId
    if (!roomId) return
    const room = await window.lc.room.addSeat(roomId, draft)
    if (room) set((s) => ({ rooms: upsertRoom(s.rooms, room) }))
  },

  editSeat: async (seatId, patch) => {
    const roomId = get().currentRoomId
    if (!roomId) return
    const room = await window.lc.room.editSeat(roomId, seatId, patch)
    if (room) set((s) => ({ rooms: upsertRoom(s.rooms, room) }))
  },

  refreshStatus: async () => {
    const roomId = get().currentRoomId
    if (!roomId) return
    const status = await window.lc.room.status(roomId).catch(() => [])
    const runtime: Record<string, SeatRuntimeView> = {}
    for (const st of status) runtime[st.seatId] = { state: st.state, tokensUsed: st.tokensUsed, paused: st.paused }
    set((s) => ({ seatRuntime: { ...s.seatRuntime, [roomId]: runtime } }))
  }
}))

function upsertRoom(rooms: Room[], room: Room): Room[] {
  const idx = rooms.findIndex((r) => r.id === room.id)
  if (idx === -1) return [room, ...rooms]
  const next = [...rooms]
  next[idx] = room
  return next
}

function addPending(pending: RoomState['pending'], roomId: string, p: InteractivePrompt): RoomState['pending'] {
  const list = pending[roomId] ?? []
  if (list.some((x) => x.requestId === p.requestId)) return pending
  return { ...pending, [roomId]: [...list, p] }
}

function dismissPending(set: (fn: (s: RoomState) => Partial<RoomState>) => void, roomId: string, requestId: string): void {
  set((s) => ({ pending: { ...s.pending, [roomId]: (s.pending[roomId] ?? []).filter((x) => x.requestId !== requestId) } }))
}
