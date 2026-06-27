// room:* IPC：群聊的列表/创建/查询、发消息、中断、提问/审批回填。
// 发言流通过 room:event 广播给渲染进程（仿 ai:event / schedule:taskUpdate）。
// 设计见 docs/群聊岗位系统策划书.md §4.2 / §7。

import { ipcMain } from 'electron'
import type { RoomDraft } from '@shared/roomTypes'
import { listRooms, createRoom, getRoom, getTranscript, updateRoom } from '../services/roomStore'
import { roomOrchestrator } from '../services/roomOrchestrator'

// 绑定微信前，探测当前已绑微信的其他群（互斥转移用，供发「已从群X转移」提示）。
function boundWeixinRoomsExcept(exceptRoomId: string | null): Array<{ id: string; title: string }> {
  return listRooms()
    .filter((r) => r.weixinBinding && r.id !== exceptRoomId)
    .map((r) => ({ id: r.id, title: r.title }))
}

export function registerRoomIpc(): void {
  ipcMain.handle('room:list', async () => listRooms())

  ipcMain.handle('room:get', async (_e, roomId: string) => getRoom(roomId))

  ipcMain.handle('room:transcript', async (_e, roomId: string) => getTranscript(roomId))

  ipcMain.handle('room:create', async (_e, draft: RoomDraft) => {
    const displaced = draft.weixinBinding ? boundWeixinRoomsExcept(null) : []
    const room = createRoom(draft) // 内部强制微信绑定全局唯一（互斥兜底）
    if (room.weixinBinding) roomOrchestrator.notifyWeixinBindingTransfer(room.id, displaced)
    return room
  })

  // 更新群安全字段（绑定微信、改 maxRounds/标题等）。
  ipcMain.handle('room:update', async (_e, roomId: string, patch: Parameters<typeof updateRoom>[1]) => {
    const binding = 'weixinBinding' in patch && patch.weixinBinding
    const displaced = binding ? boundWeixinRoomsExcept(roomId) : []
    const room = updateRoom(roomId, patch)
    if (room && binding) roomOrchestrator.notifyWeixinBindingTransfer(roomId, displaced)
    return room
  })

  // 用户发一条消息进群（fire-and-forget：编排循环在后台跑，事件经 room:event 推送）。
  ipcMain.handle('room:send', async (_e, roomId: string, text: string, mention?: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      void roomOrchestrator.postUserMessage(roomId, text, mention)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('room:stop', async (_e, roomId: string): Promise<boolean> => {
    roomOrchestrator.stop(roomId)
    return true
  })

  // 解散群聊：停掉运行态并物理删除整个群目录（聊天记录/记忆/KPI 一并删除，不可逆）。
  ipcMain.handle('room:delete', async (_e, roomId: string): Promise<boolean> => {
    return roomOrchestrator.disband(roomId)
  })

  ipcMain.handle('room:status', async (_e, roomId: string) => roomOrchestrator.getSeatStatuses(roomId))

  ipcMain.handle('room:pauseSeat', async (_e, roomId: string, seatId: string): Promise<boolean> => {
    roomOrchestrator.pauseSeat(roomId, seatId)
    return true
  })

  ipcMain.handle('room:resumeSeat', async (_e, roomId: string, seatId: string): Promise<boolean> => {
    roomOrchestrator.resumeSeat(roomId, seatId)
    return true
  })

  ipcMain.handle('room:kickSeat', async (_e, roomId: string, seatId: string): Promise<boolean> => {
    roomOrchestrator.kickSeat(roomId, seatId)
    return true
  })

  // 建群后追加岗位（U4）。draft 为不含 id/workspaceRoot/游标的岗位定义。
  ipcMain.handle('room:addSeat', async (_e, roomId: string, draft: import('@shared/roomTypes').SeatDraft) => {
    return roomOrchestrator.addSeat(roomId, draft)
  })

  // 编辑已有岗位（U4）：改名字/人设/模型/只读/启用等（id 只读）。
  ipcMain.handle('room:editSeat', async (_e, roomId: string, seatId: string, patch: Partial<Omit<import('@shared/roomTypes').Seat, 'id'>>) => {
    return roomOrchestrator.editSeat(roomId, seatId, patch)
  })

  ipcMain.handle('room:privateChat', async (_e, roomId: string, seatId: string, text: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      void roomOrchestrator.privateChat(roomId, seatId, text)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // KPI 考核（§12）。
  ipcMain.handle('room:reviewCycle', async (_e, roomId: string, period?: string): Promise<string> =>
    roomOrchestrator.runReviewCycle(roomId, period))

  ipcMain.handle('room:kpiLatest', async (_e, roomId: string) => roomOrchestrator.getLatestKpis(roomId))

  ipcMain.handle('room:kpiHistory', async (_e, roomId: string, seatId: string) =>
    roomOrchestrator.getKpiHistory(roomId, seatId))

  ipcMain.handle('room:kpiCalibrate', async (_e, roomId: string, seatId: string, patch: { kpi?: number; comment?: string }): Promise<boolean> => {
    await roomOrchestrator.calibrateKpi(roomId, seatId, patch)
    return true
  })

  ipcMain.handle('room:registerWeekly', async (_e, roomId: string): Promise<{ ok: boolean; taskName?: string }> => {
    const room = getRoom(roomId)
    if (!room) return { ok: false }
    const { registerWeeklyReport } = await import('../services/scheduleQueue')
    const task = registerWeeklyReport(roomId, room.title, 'ui')
    return { ok: true, taskName: task.name }
  })

  // 定时群会议（阶段4 / B4-1）：注册一个到点把议题投进群的定时任务。
  ipcMain.handle('room:registerRoomTask', async (_e, roomId: string, topic: string, schedule: import('@shared/scheduleTypes').ScheduleKind, delivery?: 'ui' | 'weixin'): Promise<{ ok: boolean; taskName?: string }> => {
    const room = getRoom(roomId)
    if (!room) return { ok: false }
    const { registerRoomTask } = await import('../services/scheduleQueue')
    const task = registerRoomTask(roomId, room.title, topic, schedule, delivery ?? 'ui')
    return { ok: true, taskName: task.name }
  })

  // 岗位记忆查看/编辑（错题本/经验本，§13.7 / B5-2）。
  ipcMain.handle('room:seatMemory', async (_e, roomId: string, seatId: string): Promise<string> =>
    roomOrchestrator.getSeatMemory(roomId, seatId))

  ipcMain.handle('room:seatMemorySave', async (_e, roomId: string, seatId: string, content: string): Promise<boolean> =>
    roomOrchestrator.saveSeatMemory(roomId, seatId, content))

  // 交互类事件回填（提问/审批，§7.4）。
  ipcMain.handle('room:resolveQuestion', async (_e, roomId: string, seatId: string, requestId: string, answer: string, cancelled?: boolean): Promise<boolean> => {
    roomOrchestrator.resolveUserQuestion(roomId, seatId, requestId, answer, !!cancelled)
    return true
  })

  ipcMain.handle('room:resolvePermission', async (_e, roomId: string, seatId: string, requestId: string, allow: boolean): Promise<boolean> => {
    roomOrchestrator.resolvePermission(roomId, seatId, requestId, allow)
    return true
  })
}
