import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { getRoom, findSeat } from '../../services/roomStore'

// 主 Agent（Host）专属工具：mention_seat（@ 岗位分派）、list_seats（查成员）。
// 仅注入主 Agent 的 registry（host-routed 决策，§6.3）。工人岗位不带这些工具。
//
// 关键设计：工具本身不直接调度引擎——它只做「入参校验 + 记录意图」，由 RoomOrchestrator
// 在 host 回合结束后读取记录的 mention 决定下一个发言者（§6.2/§6.3）。这样工具保持纯粹、
// 可测，调度权集中在编排器。

export const MENTION_SEAT_NAME = 'mention_seat'
export const LIST_SEATS_NAME = 'list_seats'
export const ROOM_STATUS_NAME = 'room_status'

// 一次 host 回合内主 Agent @ 的岗位（编排器读取后清空）。
export interface MentionRecord {
  seatId: string
  task: string
}

const mentionSeatSchema = z.object({
  seatId: z.string().min(1).describe('要 @ 的岗位 id（不是显示名）。可先用 list_seats 查看可用岗位及其 id。'),
  task: z.string().min(1).describe('交给该岗位的具体任务说明，会作为该岗位本回合的输入。')
})

const listSeatsSchema = z.object({})
const roomStatusSchema = z.object({})

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

  const mentionSeatTool: Tool<z.infer<typeof mentionSeatSchema>> = {
    name: MENTION_SEAT_NAME,
    description: '在群里 @ 一个岗位，请 ta 接着干活/发言。只有你（主管）能用。@ 之后该岗位会在群里发言，完成后把控制权交回给你。',
    schema: mentionSeatSchema,
    readOnly: true,
    concurrencySafe: false,
    alwaysLoad: true,
    async execute({ seatId, task }): Promise<ToolResult> {
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
      recordMention({ seatId: seat.id, task })
      return { content: `已 @「${seat.name}」并交付任务，ta 将接着发言。` }
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

  return [mentionSeatTool, listSeatsTool, roomStatusTool]
}
