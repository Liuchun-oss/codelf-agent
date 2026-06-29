import { randomUUID, randomBytes } from 'crypto'
import {
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync
} from 'fs'
import { join, dirname, basename } from 'path'
import { app } from 'electron'
import type { Room, Seat, Utterance, RoomDraft, RoomMemberBrief, SeatKpiRecord, SeatDraft } from '@shared/roomTypes'

// 群聊持久化层。照搬 scheduleQueue.ts 的「内存 + 原子写 JSON」范式，叠加 transcript.jsonl
// 的 append 写入。全部落 userData/codelf/rooms/<roomId>/，与 .codelf/agents/ 子 agent
// 物理隔离（见策划书 §3.1 / §9.1）。
//
// 目录布局：
//   userData/codelf/rooms/<roomId>/room.json        群配置 + 成员名单（内嵌 Seat）
//   userData/codelf/rooms/<roomId>/transcript.jsonl 群共享消息流（唯一事实源，§6.7）
//   userData/codelf/rooms/<roomId>/seats/<seatId>/  各岗位工作区（路径围栏边界）

// 默认主管兜底人格（§5.5：用户懒得填时）。
const DEFAULT_HOST_PERSONA = '小灵，认真负责的项目管家。说话简洁、条理清晰，乐于把复杂任务拆解清楚再分派。'

const ROOMS_DIR_SEGMENTS = ['codelf', 'rooms']

let rooms: Room[] = []
let loaded = false

function roomsRoot(): string {
  return join(app.getPath('userData'), ...ROOMS_DIR_SEGMENTS)
}

function roomDir(roomId: string): string {
  return join(roomsRoot(), roomId)
}

function roomConfigFile(roomId: string): string {
  return join(roomDir(roomId), 'room.json')
}

function transcriptFile(roomId: string): string {
  return join(roomDir(roomId), 'transcript.jsonl')
}

// 岗位工作区目录：userData/codelf/rooms/<roomId>/seats/<seatId>/。
export function seatWorkspaceDir(roomId: string, seatId: string): string {
  if (!isSafeId(seatId) || !isSafeId(roomId)) {
    throw new Error(`非法的 room/seat id（仅允许 [A-Za-z0-9_-]）：${roomId}/${seatId}`)
  }
  return join(roomDir(roomId), 'seats', seatId)
}

// id 安全字符校验（与 sessionPersistence 同规则），杜绝路径穿越。
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id)
}

// 原子写 JSON（先写 .tmp 再 rename）。
function atomicWriteJson(target: string, data: unknown): void {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, target)
}

// 扫 rooms/*/room.json 把全部群加载进内存。
function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  rooms = []
  try {
    const root = roomsRoot()
    if (!existsSync(root)) return
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const cfg = roomConfigFile(entry.name)
      if (!existsSync(cfg)) continue
      try {
        const room = JSON.parse(readFileSync(cfg, 'utf-8')) as Room
        if (room && typeof room.id === 'string') rooms.push(room)
      } catch {
        /* 单个群解析失败则跳过，不影响其它群 */
      }
    }
  } catch {
    rooms = []
  }
}

function persistRoom(room: Room): void {
  try {
    atomicWriteJson(roomConfigFile(room.id), room)
  } catch {
    /* 持久化失败不致命，下次再写 */
  }
}

// ===== 群 CRUD =====

export function listRooms(): Room[] {
  ensureLoaded()
  return [...rooms].sort((a, b) => b.createdAt - a.createdAt)
}

export function getRoom(roomId: string): Room | null {
  ensureLoaded()
  return rooms.find((r) => r.id === roomId) ?? null
}

// 微信物理上只有一条线性会话 → 全局最多一个群可绑微信（互斥硬不变量）。
// 给某群绑微信前，先解绑其他所有群。返回被解绑的群（id+标题），供上层提示「微信已从群A转到群B」。
export function unbindOtherWeixinRooms(exceptRoomId: string): Array<{ id: string; title: string }> {
  ensureLoaded()
  const displaced: Array<{ id: string; title: string }> = []
  for (const r of rooms) {
    if (r.id !== exceptRoomId && r.weixinBinding) {
      displaced.push({ id: r.id, title: r.title })
      delete r.weixinBinding
      persistRoom(r)
    }
  }
  return displaced
}

export function createRoom(draft: RoomDraft): Room {
  ensureLoaded()
  const id = `room-${randomUUID()}`
  const dir = roomDir(id)
  const seats: Seat[] = draft.seats.map((s) => normalizeSeatForCreate(id, s))
  ensureHostPersona(seats, draft.hostSeatId)
  const room: Room = {
    id,
    title: draft.title.trim() || '未命名群',
    seats,
    hostSeatId: draft.hostSeatId,
    rootDir: dir,
    speakingPolicy: draft.speakingPolicy ?? 'host-routed',
    maxRounds: draft.maxRounds ?? 0,
    createdAt: Date.now(),
    ...(draft.weixinBinding ? { weixinBinding: draft.weixinBinding } : {})
  }
  // 建群目录 + 各岗位工作区目录（§11.10：避免首次写文件因目录不存在异常）。
  mkdirSync(dir, { recursive: true })
  for (const seat of seats) {
    if (seat.workspaceRoot) mkdirSync(seat.workspaceRoot, { recursive: true })
  }
  rooms.push(room)
  persistRoom(room)
  // 互斥兜底：若本群绑了微信，解绑其他群（数据层强制全局唯一，不依赖 UI 自觉）。
  if (room.weixinBinding) unbindOtherWeixinRooms(room.id)
  return room
}

// 创建岗位时规范化：补全工作区路径、默认禁用 run_subagent（host-only 决策）。
function normalizeSeatForCreate(roomId: string, seat: Omit<Seat, 'lastSeenUtteranceSeq' | 'workspaceRoot'> & { workspaceRoot?: string | null }): Seat {
  const isHost = !!seat.isHost
  // 工人岗位强制禁用 run_subagent（双保险，配合 registry 过滤，见策划书 §6.3）。
  const denied = new Set(seat.deniedTools ?? [])
  if (!isHost) denied.add('run_subagent')
  // workspaceRoot：null 表示纯对话岗位；否则落到 seats/<id>/。
  const workspaceRoot =
    seat.workspaceRoot === null
      ? null
      : seat.workspaceRoot || seatWorkspaceDir(roomId, seat.id)
  return {
    ...seat,
    workspaceRoot,
    deniedTools: [...denied],
    lastSeenUtteranceSeq: 0
  }
}

// 主 Agent 无人格时给出厂默认主管兜底（§5.5）。
function ensureHostPersona(seats: Seat[], hostSeatId: string): void {
  const host = seats.find((s) => s.id === hostSeatId)
  if (host && !host.personaPrompt.trim()) {
    host.personaPrompt = DEFAULT_HOST_PERSONA
  }
}

// 更新群（仅允许改安全字段；id 只读，见 §11.7）。
export function updateRoom(roomId: string, patch: Partial<Pick<Room, 'title' | 'maxRounds' | 'speakingPolicy' | 'weixinBinding' | 'interrupted'>>): Room | null {
  ensureLoaded()
  const idx = rooms.findIndex((r) => r.id === roomId)
  if (idx === -1) return null
  rooms[idx] = { ...rooms[idx], ...patch }
  persistRoom(rooms[idx])
  // 互斥兜底：本次更新若给本群绑了微信，解绑其他群（全局唯一）。
  if ('weixinBinding' in patch && patch.weixinBinding) unbindOtherWeixinRooms(roomId)
  return rooms[idx]
}

// 解散群聊：从内存移除并递归删除整个群目录（room.json + transcript + 各岗位工作区/记忆/KPI）。
// 不可逆。调用方（编排器/IPC）须先 stop 该群的运行态。返回是否删除成功。
export function deleteRoom(roomId: string): boolean {
  ensureLoaded()
  const idx = rooms.findIndex((r) => r.id === roomId)
  if (idx === -1) return false
  // 先取消本群待落盘的游标定时器，避免删目录后定时器仍触发 persistRoom 重建 room.json（幽灵文件）。
  const timer = cursorPersistTimers.get(roomId)
  if (timer) { clearTimeout(timer); cursorPersistTimers.delete(roomId) }
  rooms.splice(idx, 1)
  transcripts.delete(roomId) // 清内存 transcript 缓存，防止泄漏与残留读取
  // 物理删除前再次校验 id，杜绝路径穿越删到 rooms/ 之外。
  if (!isSafeId(roomId)) throw new Error(`非法的 room id（仅允许 [A-Za-z0-9_-]）：${roomId}`)
  const dir = roomDir(roomId)
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    console.error('[roomStore] 删除群目录失败：', dir, e)
  }
  return true
}

// 更新单个岗位（id 创建后只读；可改 name/persona/model/权限/enabled/游标）。
export function updateSeat(roomId: string, seatId: string, patch: Partial<Omit<Seat, 'id'>>): Room | null {
  ensureLoaded()
  const room = rooms.find((r) => r.id === roomId)
  if (!room) return null
  const seat = room.seats.find((s) => s.id === seatId)
  if (!seat) return null
  Object.assign(seat, patch)
  persistRoom(room)
  return room
}

export function findSeat(roomId: string, seatId: string): Seat | null {
  const room = getRoom(roomId)
  return room?.seats.find((s) => s.id === seatId) ?? null
}

// 建群后追加一个岗位（U4）。复用 normalizeSeatForCreate 补全工作区/禁用 run_subagent。
export function addSeat(roomId: string, draft: SeatDraft): Room | null {
  ensureLoaded()
  const room = rooms.find((r) => r.id === roomId)
  if (!room) return null
  const id = draft.id && isSafeId(draft.id) ? draft.id : `seat-${randomUUID()}`
  if (room.seats.some((s) => s.id === id)) return room
  const seat = normalizeSeatForCreate(roomId, { ...draft, id, isHost: false })
  if (seat.workspaceRoot) mkdirSync(seat.workspaceRoot, { recursive: true })
  room.seats.push(seat)
  persistRoom(room)
  return room
}

// 按显示名找岗位（@ 用，大小写不敏感）。
export function findSeatByName(roomId: string, name: string): Seat | null {
  const room = getRoom(roomId)
  if (!room) return null
  const target = name.trim().toLowerCase()
  return room.seats.find((s) => s.name.trim().toLowerCase() === target) ?? null
}

// 群成员简表（注入提示词用，过滤掉敏感的完整定义）。
export function roomMemberBriefs(roomId: string): RoomMemberBrief[] {
  const room = getRoom(roomId)
  if (!room) return []
  return room.seats.map((s) => ({
    id: s.id,
    name: s.name,
    role: s.role,
    isHost: !!s.isHost,
    enabled: s.enabled
  }))
}

// ===== transcript（群共享消息流，唯一事实源 §6.7）=====

// 内存里维护每个群的 transcript（启动时从 jsonl 一次性载入）。
const transcripts = new Map<string, Utterance[]>()

function loadTranscript(roomId: string): Utterance[] {
  const cached = transcripts.get(roomId)
  if (cached) return cached
  const list: Utterance[] = []
  try {
    const f = transcriptFile(roomId)
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf-8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const u = JSON.parse(trimmed) as Utterance
          if (u && typeof u.seq === 'number') list.push(u)
        } catch {
          /* 跳过损坏行 */
        }
      }
    }
  } catch {
    /* 读失败按空流 */
  }
  transcripts.set(roomId, list)
  return list
}

// 追加一条发言：先内存、再 append 落盘（事实源落定，§6.7 的写顺序）。
export function appendUtterance(
  roomId: string,
  u: Omit<Utterance, 'seq' | 'ts'> & { ts?: number }
): Utterance {
  const list = loadTranscript(roomId)
  const seq = (list[list.length - 1]?.seq ?? 0) + 1
  const utterance: Utterance = {
    seq,
    from: u.from,
    text: u.text,
    ts: u.ts ?? Date.now(),
    ...(u.to ? { to: u.to } : {}),
    ...(u.visibility && u.visibility.length ? { visibility: u.visibility } : {})
  }
  list.push(utterance)
  try {
    const f = transcriptFile(roomId)
    mkdirSync(dirname(f), { recursive: true })
    appendFileSync(f, JSON.stringify(utterance) + '\n', 'utf-8')
  } catch {
    /* 落盘失败不致命，内存仍有 */
  }
  return utterance
}

export function getTranscript(roomId: string): Utterance[] {
  return [...loadTranscript(roomId)]
}

// ===== KPI 考核记录持久化（§12.5）=====
// 落盘 userData/codelf/rooms/<roomId>/kpi/<seatId>.jsonl，每行一条历史记录（可画曲线）。
function kpiFile(roomId: string, seatId: string): string {
  if (!isSafeId(roomId) || !isSafeId(seatId)) {
    throw new Error(`非法的 room/seat id：${roomId}/${seatId}`)
  }
  return join(roomDir(roomId), 'kpi', `${seatId}.jsonl`)
}

// 追加一条 KPI 记录（append-only，可追溯历史）。
export function appendKpiRecord(roomId: string, rec: SeatKpiRecord): void {
  try {
    const f = kpiFile(roomId, rec.seatId)
    mkdirSync(dirname(f), { recursive: true })
    appendFileSync(f, JSON.stringify(rec) + '\n', 'utf-8')
  } catch {
    /* 落盘失败不致命 */
  }
}

// 读某岗位的 KPI 历史（按时间升序）。
export function readKpiHistory(roomId: string, seatId: string): SeatKpiRecord[] {
  try {
    const f = kpiFile(roomId, seatId)
    if (!existsSync(f)) return []
    return readFileSync(f, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as SeatKpiRecord)
  } catch {
    return []
  }
}

// 读全群所有岗位的最新一条 KPI（战报仪表盘用）。
export function readLatestKpis(roomId: string): SeatKpiRecord[] {
  const room = getRoom(roomId)
  if (!room) return []
  const out: SeatKpiRecord[] = []
  for (const seat of room.seats) {
    const hist = readKpiHistory(roomId, seat.id)
    if (hist.length) out.push(hist[hist.length - 1])
  }
  return out
}

// 收集某岗位「自上次发言以来的未读消息」（§6.2 collectUnseenFor）。
// 不含该岗位自己说的话；更新游标由 markSeen 单独完成（发言成功后再推进）。
// 私信过滤：带 visibility 白名单的消息，仅当本岗位在白名单内才可见（其余工人读不到）。
export function collectUnseenFor(roomId: string, seatId: string): Utterance[] {
  const list = loadTranscript(roomId)
  const seat = findSeat(roomId, seatId)
  const since = seat?.lastSeenUtteranceSeq ?? 0
  return list.filter((u) => {
    if (u.seq <= since || u.from === seatId) return false
    // 公开消息（无 visibility）全员可见；私信仅白名单内岗位可见。
    if (u.visibility && u.visibility.length) return u.visibility.includes(seatId)
    return true
  })
}

// 推进某岗位的「已读水位」到最新一条（§11.5：游标持久化）。
// 游标是非关键状态（重启最多重读几条已读消息，无害），故只改内存 + 防抖落盘，
// 避免每个岗位每回合都全量原子重写 room.json（B1-3 性能优化）。
export function markSeen(roomId: string, seatId: string): void {
  ensureLoaded()
  const room = rooms.find((r) => r.id === roomId)
  if (!room) return
  const seat = room.seats.find((s) => s.id === seatId)
  if (!seat) return
  const latest = loadTranscript(roomId)[loadTranscript(roomId).length - 1]?.seq ?? 0
  if (seat.lastSeenUtteranceSeq === latest) return
  seat.lastSeenUtteranceSeq = latest
  scheduleCursorPersist(roomId)
}

// 游标防抖落盘：1.5s 内的多次游标推进合并为一次 room.json 写盘。
const cursorPersistTimers = new Map<string, ReturnType<typeof setTimeout>>()
const CURSOR_PERSIST_DEBOUNCE_MS = 1500

function scheduleCursorPersist(roomId: string): void {
  const existing = cursorPersistTimers.get(roomId)
  if (existing) clearTimeout(existing)
  cursorPersistTimers.set(
    roomId,
    setTimeout(() => {
      cursorPersistTimers.delete(roomId)
      const room = rooms.find((r) => r.id === roomId)
      if (room) persistRoom(room)
    }, CURSOR_PERSIST_DEBOUNCE_MS)
  )
}

// 立即冲刷待落盘的游标（退出前调用，避免丢失最后一批游标推进）。
export function flushCursorPersist(): void {
  for (const [roomId, timer] of cursorPersistTimers) {
    clearTimeout(timer)
    const room = rooms.find((r) => r.id === roomId)
    if (room) persistRoom(room)
  }
  cursorPersistTimers.clear()
}

// ===== 启动恢复（§6.8）=====
// 懒加载：只加载群定义，不为每个岗位建引擎（引擎在岗位下次被调度时按需建 + 恢复历史）。
// 若某群上次崩溃在「发言循环半途」（running 状态残留无法判断），不自动续跑，
// 只标记 interrupted，由用户在 UI 点「继续」或重新发话——避免重启自动烧 token。
export function resumeRoomsOnStartup(): void {
  ensureLoaded()
  for (const room of rooms) {
    // 预载 transcript 进内存，保证 seq 连续。
    loadTranscript(room.id)
    // 这里不主动续跑任何循环。仅做一致性标记：本版不持久化「循环进行中」标志，
    // 故无需逐个群判断；interrupted 字段保留给 UI 显式标注未完成会话。
  }
}

