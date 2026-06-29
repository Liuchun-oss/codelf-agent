import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { getRoom, findSeat } from '../../services/roomStore'

// 主 Agent（Host）专属工具：mention_seat（@ 岗位分派）、private_message（私信岗位）、
// list_seats（查成员）、room_status（查进度）。仅注入主 Agent 的 registry（host-routed 决策，§6.3）。
// 工人岗位不带这些工具。
//
// 关键设计：工具本身不直接调度引擎——它只做「入参校验 + 记录意图」，由 RoomOrchestrator
// 在 host 回合结束后读取记录的 mention 决定下一个发言者（§6.2/§6.3）。这样工具保持纯粹、
// 可测，调度权集中在编排器。

export const MENTION_SEAT_NAME = 'mention_seat'
export const LIST_SEATS_NAME = 'list_seats'
export const ROOM_STATUS_NAME = 'room_status'
export const PRIVATE_MESSAGE_NAME = 'private_message'
export const WHISPER_TEAMMATE_NAME = 'whisper_teammate'

// 一次 host 回合内主 Agent @ 的岗位（编排器读取后清空）。
// private=true：私信，本条交代只有收发双方可见，其他工人岗位读不到（写 transcript 时带 visibility）。
export interface MentionRecord {
  seatId: string
  task: string
  private?: boolean
}

const mentionSeatSchema = z.object({
  seatId: z.string().min(1).describe('要 @ 的岗位 id（不是显示名）。可先用 list_seats 查看可用岗位及其 id。'),
  task: z.string().min(1).describe('交给该岗位的具体任务说明，会作为该岗位本回合的输入。')
})

const privateMessageSchema = z.object({
  seatId: z.string().min(1).describe('要私信的岗位 id（不是显示名）。可先用 list_seats 查看可用岗位及其 id。'),
  task: z.string().min(1).describe('私下交代给该岗位的任务/内容，会作为该岗位本回合的输入。其他工人岗位看不到这条。')
})

const listSeatsSchema = z.object({})
const roomStatusSchema = z.object({})

const whisperTeammateSchema = z.object({
  seatIds: z
    .array(z.string().min(1))
    .min(1)
    .describe('要私语的一个或多个岗位 id（不是显示名）。传多个即群发给整组队友。可先用 list_seats 查看可用岗位及其 id。'),
  message: z.string().min(1).describe('私下留言内容。只有你和这些岗位能看到，其他岗位（含主管之外的人）看不到。ta 们下次发言时会读到。')
})

/**
 * 构建绑定到某个群 + host 岗位的工具集。
 * @param roomId 群 id
 * @param hostSeatId 当前 host 岗位 id（防止 @ 自己，§11.3）
 * @param recordMention 编排器提供的回调：记录一条合法 mention
 */
export function createRoomHostTools(params: {
  roomId: string
  hostSeatId: string
  recordMention: (m: MentionRecord) => void
  describeProgress: () => string
}): Tool[] {
  const { roomId, hostSeatId, recordMention, describeProgress } = params

  // @ 派活的公共校验 + 记录（mention_seat 与 private_message 共用，仅 private 标记不同）。
  const dispatchMention = (seatId: string, task: string, isPrivate: boolean): ToolResult => {
    const room = getRoom(roomId)
    if (!room) return { content: `群不存在：${roomId}`, isError: true }
    // §11.3 入参校验：不存在 / 禁用 / @ 自己 → 报错给主 Agent，不进发言队列。
    const seat = findSeat(roomId, seatId)
    if (!seat) {
      const ids = room.seats.filter((s) => !s.isHost).map((s) => `${s.id}(${s.name})`).join('、')
      return { content: `群里没有这个岗位：${seatId}。可用岗位：${ids || '（暂无工人岗位）'}`, isError: true }
    }
    if (seat.id === hostSeatId || seat.isHost) {
      return { content: '不能 @ 你自己（主管）。请 @ 一个工人岗位，或直接完成并回复用户。', isError: true }
    }
    if (!seat.enabled) {
      return { content: `岗位「${seat.name}」当前被禁用，无法分派。`, isError: true }
    }
    recordMention({ seatId: seat.id, task, private: isPrivate })
    return {
      content: isPrivate
        ? `已私信「${seat.name}」并交付任务（其他岗位不可见），ta 将接着发言。`
        : `已 @「${seat.name}」并交付任务，ta 将接着发言。`
    }
  }

  const mentionSeatTool: Tool<z.infer<typeof mentionSeatSchema>> = {
    name: MENTION_SEAT_NAME,
    description:
      '在群里 @ 一个岗位，请 ta 接着干活/发言。只有你（主管）能用。@ 之后该岗位会在群里发言，完成后把控制权交回给你。\n' +
      '可在同一回合多次调用以批量派发：被 @ 的岗位会按你调用的先后顺序依次发言，全部轮完后再回到你（适合一次给多个岗位分派任务）。',
    schema: mentionSeatSchema,
    readOnly: true,
    concurrencySafe: false,
    alwaysLoad: true,
    async execute({ seatId, task }): Promise<ToolResult> {
      return dispatchMention(seatId, task, false)
    }
  }

  const privateMessageTool: Tool<z.infer<typeof privateMessageSchema>> = {
    name: PRIVATE_MESSAGE_NAME,
    description:
      '私信一个工人岗位：私下把任务/内容交代给 ta，其他工人岗位看不到这条消息（只有你和 ta 可见）。' +
      '用法与 mention_seat 相同（@ 后该岗位接着发言、完成交回控制权，也可同一回合多次调用批量派发），区别仅在「可见性私密」。' +
      '适合：单独叮嘱某人、避免无关岗位被打扰或被带偏、交代敏感或定向信息。只有你（主管）能用。',
    schema: privateMessageSchema,
    readOnly: true,
    concurrencySafe: false,
    alwaysLoad: true,
    async execute({ seatId, task }): Promise<ToolResult> {
      return dispatchMention(seatId, task, true)
    }
  }

  const listSeatsTool: Tool<z.infer<typeof listSeatsSchema>> = {
    name: LIST_SEATS_NAME,
    description: '列出本群所有岗位（id / 名字 / 职责 / 状态），用于决定把任务 @ 给谁。',
    schema: listSeatsSchema,
    readOnly: true,
    concurrencySafe: true,
    alwaysLoad: true,
    async execute(): Promise<ToolResult> {
      const room = getRoom(roomId)
      if (!room) return { content: `群不存在：${roomId}`, isError: true }
      const lines = room.seats.map((s) => {
        const tags = [s.isHost ? '群主' : null, s.enabled ? null : '已禁用', s.readOnly ? '只读' : null].filter(Boolean).join('/')
        return `- ${s.id}（${s.name}）：${s.role}${tags ? ` [${tags}]` : ''}`
      })
      return { content: ['群成员：', ...lines].join('\n') }
    }
  }

  const roomStatusTool: Tool<z.infer<typeof roomStatusSchema>> = {
    name: ROOM_STATUS_NAME,
    description: '查看各岗位当前进度/状态/token 用量（谁在干啥、谁卡住了）。用户问「进度咋样」时用，再把结果转述成人话回复用户。',
    schema: roomStatusSchema,
    readOnly: true,
    concurrencySafe: true,
    alwaysLoad: true,
    async execute(): Promise<ToolResult> {
      return { content: describeProgress() }
    }
  }

  return [mentionSeatTool, privateMessageTool, listSeatsTool, roomStatusTool]
}

// 工人岗位专属工具：whisper_teammate（队友私语，支持群发）。
// host-routed 下工人不能调度发言，故 whisper 是「留言」语义：写一条带 visibility 白名单的消息进
// transcript（仅自己 + 指定队友可见），不改变发言流转；目标岗位下次被主管 @ 发言时会读到。
// 支持一次发给多个岗位 → 等于一个临时小组私聊（一组队友看到同一条、信息同步）。
export function createRoomWorkerTools(params: {
  roomId: string
  selfSeatId: string
  recordWhisper: (toSeatIds: string[], message: string) => boolean
}): Tool[] {
  const { roomId, selfSeatId, recordWhisper } = params

  const whisperTool: Tool<z.infer<typeof whisperTeammateSchema>> = {
    name: WHISPER_TEAMMATE_NAME,
    description:
      '私语一个或多个岗位：写一条只有你和这些岗位能看到的留言，其他岗位（包括其他工人和未被点到的人）都看不到。' +
      '传多个 id 即群发给一组队友，大家看到同一条、信息同步。' +
      '这不是发言、不会打断流程——ta 们下次轮到发言时会读到。传岗位的 id，不是显示名。',
    schema: whisperTeammateSchema,
    readOnly: true,
    concurrencySafe: false,
    alwaysLoad: true,
    async execute({ seatIds, message }): Promise<ToolResult> {
      const room = getRoom(roomId)
      if (!room) return { content: `群不存在：${roomId}`, isError: true }
      // 去重 + 排除自己。
      const requested = [...new Set(seatIds)].filter((id) => id !== selfSeatId)
      if (requested.length === 0) return { content: '请至少指定一个你之外的岗位。', isError: true }
      const valid: string[] = []
      const invalid: string[] = []
      for (const id of requested) {
        const target = findSeat(roomId, id)
        if (target && target.enabled) valid.push(id)
        else invalid.push(id)
      }
      if (valid.length === 0) {
        const ids = room.seats.filter((s) => s.id !== selfSeatId).map((s) => `${s.id}(${s.name})`).join('、')
        return { content: `没有可私语的有效岗位（${invalid.join('、')}）。可选：${ids || '（无）'}`, isError: true }
      }
      const ok = recordWhisper(valid, message)
      if (!ok) return { content: '私语发送失败。', isError: true }
      const names = valid.map((id) => findSeat(roomId, id)?.name ?? id).join('、')
      const skipNote = invalid.length ? `（已跳过无效岗位：${invalid.join('、')}）` : ''
      return { content: `已私语「${names}」（仅 ta 们可见），下次发言时会看到。${skipNote}` }
    }
  }

  return [whisperTool]
}
