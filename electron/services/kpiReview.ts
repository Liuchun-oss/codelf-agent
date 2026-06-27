// 考核与激励（§12）+ 错题本（§13）的核心计算与记忆写入。
// 设计：纯函数（打分提示词组装、记忆小节渲染/合并）可隔离测试；LLM 调用 best-effort。
//
// 闭环：编排器采信号 → 这里喂主管引擎打分 → 写 KPI 记录 + 把「绩效档案」「错题本」
// 小节合并进岗位 MEMORY.md → 下次该岗位开工时随记忆注入 system prompt（§12.4/§13.4）。

import { createAdapter, type ChatMessage } from '../agent/providers'
import { getActiveProfileId, getProfileRaw, getActiveProfileApiKey } from '../agent/providers/profileStore'
import { ensureProjectMemory, readProjectMemoryContent, writeProjectMemoryContent, readGlobalMemoryContent, writeGlobalMemoryContent } from '../agent/memory/store'
import type { SeatSignals, SeatKpiRecord } from '@shared/roomTypes'

// 单个岗位送考的输入。
export interface SeatReviewInput {
  seatId: string
  seatName: string
  role: string
  signals: SeatSignals
  // 本周期该岗位发言摘要（取最近若干条拼接）。
  digest: string
  // 本周期失败信号明细（错题来源）。
  failures: string[]
  // workspaceRoot（写记忆用）；null = 纯对话岗位，跳过记忆写入。
  workspaceRoot: string | null
}

const PERF_HEADER = '## 我的绩效档案（主管考核·只读自省）'
const MISTAKE_HEADER = '## §错题本（踩坑记录）'
const MASTERED_HEADER = '## §已掌握·深藏'
const GLOBAL_LESSON_HEADER = '## §通用职业教训（全岗位通用）'

// §13.6 毕业阈值：同一坑连续 N 个周期未重犯 → 归档到「已掌握」。
const GRADUATE_STREAK = 5

// 主管打分提示词（§12.3）：客观信号 + 发言摘要 → 结构化 JSON。
export function buildReviewMessages(inputs: SeatReviewInput[], period: string): ChatMessage[] {
  const system =
    '你是团队主管，正在做周期绩效考核。基于「客观信号」+「发言摘要」给每个岗位打分，避免凭感觉。\n' +
    '打分维度：质量、效率、自主性、协作（各 0-100），综合 kpi（0-100）。\n' +
    '要求：\n' +
    '1. 措辞建设性——improvements 写「下次应 X」而非贬低；高分肯定，低分给明确改进方向。\n' +
    '2. 客观信号是硬约束：返工/越界/报错多 → 质量或自主性扣分；提问过多 → 自主性扣分；token/耗时高 → 效率扣分。\n' +
    '3. 新岗位无历史时给中性基准（约 70），不要无依据给极端分。\n' +
    '4. 只输出 JSON 数组，每个元素形如：\n' +
    '{"seatId":"...","kpi":82,"dimensions":{"质量":85,"效率":78,"自主性":80,"协作":86},' +
    '"highlights":["..."],"improvements":["..."],"comment":"..."}\n' +
    '不要附加任何解释或代码围栏。'

  const body = inputs
    .map((i) => {
      const s = i.signals
      return (
        `### 岗位 ${i.seatName}（id=${i.seatId}，职责：${i.role}）\n` +
        `客观信号：返工 ${s.reworks}、越界 ${s.outOfBounds}、提问 ${s.questions}、报错 ${s.errors}、` +
        `完成 ${s.completed ? '是' : '否'}、token ${s.tokens}、耗时 ${Math.round(s.durationMs / 1000)}s\n` +
        `发言摘要：${i.digest || '(本周期无发言)'}`
      )
    })
    .join('\n\n')

  const user = `考核周期：${period}\n\n${body}\n\n请对以上 ${inputs.length} 个岗位逐一打分，输出 JSON 数组。`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

// 主管打分原始输出（容错解析）。
interface RawScore {
  seatId: string
  kpi: number
  dimensions: Record<string, number>
  highlights: string[]
  improvements: string[]
  comment: string
}

// 从 LLM 文本里抠出 JSON 数组（容忍代码围栏/前后噪声）。
export function parseScores(text: string): RawScore[] {
  if (!text) return []
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = t.indexOf('[')
  const end = t.lastIndexOf(']')
  if (start >= 0 && end > start) t = t.slice(start, end + 1)
  try {
    const arr = JSON.parse(t)
    if (!Array.isArray(arr)) return []
    return arr.filter((x) => x && typeof x.seatId === 'string')
  } catch {
    return []
  }
}

// 信号兜底打分（LLM 不可用时的客观降级，§12.8 防失真）。
export function fallbackScore(input: SeatReviewInput): RawScore {
  const s = input.signals
  let kpi = 75
  kpi -= s.reworks * 6 + s.outOfBounds * 8 + s.errors * 7 + Math.max(0, s.questions - 1) * 3
  if (s.completed) kpi += 8
  kpi = Math.max(40, Math.min(95, Math.round(kpi)))
  const improvements: string[] = []
  if (s.outOfBounds) improvements.push('避免越界写入，只动自己的工作区')
  if (s.reworks) improvements.push('动手前先确认需求/现有实现，减少返工')
  if (s.errors) improvements.push('调用工具前核对参数，降低报错率')
  return {
    seatId: input.seatId,
    kpi,
    dimensions: { 质量: kpi, 效率: kpi, 自主性: kpi, 协作: kpi },
    highlights: s.completed ? ['按时产出，完成本周期任务'] : [],
    improvements,
    comment: '（自动评定：主管引擎暂不可用，按客观信号给出基准分）'
  }
}

// 渲染「绩效档案」小节正文（§12.4），用最新 KPI + 主管评语引导下次行为。
export function renderPerfSection(rec: SeatKpiRecord, trend: string): string {
  const lines = [PERF_HEADER]
  lines.push(`- 最近 KPI：${rec.kpi}${trend ? `（${trend}）` : ''}`)
  if (rec.highlights.length) lines.push(`- 长板：${rec.highlights.join('；')}`)
  if (rec.improvements.length) lines.push(`- 短板：${rec.improvements.join('；')}`)
  if (rec.comment) lines.push(`- 主管寄语：${rec.comment}`)
  return lines.join('\n')
}

// 错题语义归一化键（§13.6 修复核心）：剥离路径/错误码/数字/引号等高可变值，
// 只留「[类型标签] + 指导语」，让"同一类坑换个文件名/错误码"也能被判定为同一条。
// 去重（renderMistakeEntries）、合并、老化/毕业（mergeAndAgeMistakes）三处共用此键。
export function mistakeKey(text: string): string {
  const t = normalizeMistake(text)
  const tag = t.match(/^\[([^\]]+)\]/)?.[0] ?? ''
  // 结构化失败明细形如「[标签] 可变描述 → 稳定指导语」：指导语是去重锚点。
  const arrowIdx = t.search(/[→]/)
  if (arrowIdx >= 0) {
    return `${tag} → ${t.slice(arrowIdx + 1).trim()}`.trim()
  }
  // 无箭头（如 [报错] CODE：message）：剥离路径/引号内容/数字等可变部分。
  const stripped = t
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/[A-Za-z]:[\\/][^\s，。：:]*/g, '')
    .replace(/[\\/][^\s，。：:]*/g, '')
    .replace(/["'`][^"'`]*["'`]/g, '')
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `${tag} ${stripped}`.replace(/\s+/g, ' ').trim()
}

// 把失败明细转成错题条目（§13.4），按语义键去重（避免同类坑换路径就留多条）。
export function renderMistakeEntries(failures: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const f of failures) {
    const key = mistakeKey(f)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(`- ❌ ${f}`)
  }
  return out
}

// 把一个 ## 小节合并进 MEMORY.md：存在则替换该小节正文，不存在则追加。
// 错题本特殊：合并旧条目 + 新条目去重。
export function upsertSection(memory: string, header: string, bodyLines: string[], mergeList = false): string {
  const lines = memory.split('\n')
  const startIdx = lines.findIndex((l) => l.trim() === header)
  if (startIdx < 0) {
    const sep = memory.trim() ? '\n\n' : ''
    return `${memory.trimEnd()}${sep}${header}\n${bodyLines.join('\n')}\n`
  }
  // 找小节结束（下一个 ## 或文件尾）。
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { endIdx = i; break }
  }
  let newBody = bodyLines
  if (mergeList) {
    const old = lines.slice(startIdx + 1, endIdx).filter((l) => l.trim().startsWith('-'))
    const merged = new Set<string>()
    for (const l of [...old, ...bodyLines]) merged.add(l.trim())
    newBody = [...merged]
  }
  return [...lines.slice(0, startIdx), header, ...newBody, ...lines.slice(endIdx)].join('\n')
}

// §13.5 判定一条教训是否「通用职业教训」（不依赖具体项目，对任何任务都适用）。
// 启发式：含通用关键词（动手前、先确认、备份、看现有实现等）或越界类 → 通用。
export function isGeneralLesson(failure: string): boolean {
  const general = ['动手前', '先确认', '先看', '先跑', '备份', '越界', '只动自己', '需求', '现有实现', '核对参数']
  return general.some((k) => failure.includes(k))
}

// 把失败明细拆成「项目级」「通用级」两组（§13.5）。
export function splitLessons(failures: string[]): { project: string[]; global: string[] } {
  const project: string[] = []
  const global: string[] = []
  for (const f of failures) {
    if (isGeneralLesson(f)) global.push(f)
    else project.push(f)
  }
  return { project, global }
}

// §13.4+§13.6 合并入账与老化（修复 B1-1/B5-1）：一步完成「插入本周期新坑 + 命中重置/未犯+1 + 毕业」。
// 共用 mistakeKey 做同一性判定，避免"先写带 0 前缀、再 age"两步在带计数器整行上去重失败导致的重复膨胀。
// - insertTexts：本周期要确保在册的项目级新坑（纯文本，无前缀）。
// - activeTexts：本周期实际又踩的所有坑（判定旧条目 clean 重置/递增）。
// - aging=false 时只插入不推进 clean（人工校准等非任务周期场景，§B5-3）。
export function mergeAndAgeMistakes(
  memory: string,
  insertTexts: string[],
  activeTexts: string[],
  aging = true
): string {
  const lines = memory.split('\n')
  const { startIdx, endIdx } = sectionRange(lines, MISTAKE_HEADER)
  const activeKeys = new Set(activeTexts.map((t) => mistakeKey(t)))
  // 解析现有条目为 key → {hit, clean, text}（同 key 取已存在的第一条，天然去重旧的重复行）。
  const map = new Map<string, { hit: number; clean: number; text: string }>()
  if (startIdx >= 0) {
    for (let i = startIdx + 1; i < endIdx; i++) {
      const parsed = parseMistakeLine(lines[i])
      if (!parsed) continue
      const key = mistakeKey(parsed.text)
      if (map.has(key)) {
        const cur = map.get(key)!
        cur.hit += parsed.hit
        continue
      }
      map.set(key, { hit: parsed.hit, clean: parsed.clean, text: parsed.text })
    }
  }
  if (aging) {
    for (const [key, e] of map) {
      if (activeKeys.has(key)) { e.clean = 0; e.hit += 1 } else { e.clean += 1 }
    }
  }
  for (const text of insertTexts) {
    const key = mistakeKey(text)
    if (!map.has(key)) map.set(key, { hit: 1, clean: 0, text })
  }
  const kept: string[] = []
  const graduated: string[] = []
  for (const e of map.values()) {
    if (e.clean >= GRADUATE_STREAK) graduated.push(`- ✅ ${normalizeMistake(e.text)}`)
    else kept.push(`- ❌ [hit=${e.hit},clean=${e.clean}] ${normalizeMistake(e.text)}`)
  }
  let out = startIdx >= 0
    ? replaceSection(lines, MISTAKE_HEADER, kept.length ? kept : ['(暂无)'])
    : (kept.length ? upsertSection(memory, MISTAKE_HEADER, kept) : memory)
  if (graduated.length) out = upsertSection(out, MASTERED_HEADER, graduated, true)
  return out
}

// 兼容旧调用：仅老化（不插入新坑）。内部委托 mergeAndAgeMistakes。
export function ageMistakes(memory: string, activeFailures: string[]): string {
  return mergeAndAgeMistakes(memory, [], activeFailures, true)
}

function normalizeMistake(text: string): string {
  return text.replace(/^\[hit=\d+,clean=\d+\]\s*/, '').trim()
}

function parseMistakeLine(line: string): { hit: number; clean: number; text: string } | null {
  const m = line.match(/^-\s*❌\s*(?:\[hit=(\d+),clean=(\d+)\]\s*)?(.+)$/)
  if (!m) return null
  return { hit: Number(m[1] ?? 1), clean: Number(m[2] ?? 0), text: m[3].trim() }
}

function sectionRange(lines: string[], header: string): { startIdx: number; endIdx: number } {
  const startIdx = lines.findIndex((l) => l.trim() === header)
  if (startIdx < 0) return { startIdx: -1, endIdx: -1 }
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { endIdx = i; break }
  }
  return { startIdx, endIdx }
}

function replaceSection(lines: string[], header: string, body: string[]): string {
  const { startIdx, endIdx } = sectionRange(lines, header)
  if (startIdx < 0) return lines.join('\n')
  return [...lines.slice(0, startIdx), header, ...body, ...lines.slice(endIdx)].join('\n')
}

// §13.5 把通用教训写进全局 MEMORY.md（所有项目/岗位共享）。best-effort。
export async function promoteGlobalLessons(lessons: string[]): Promise<boolean> {
  if (lessons.length === 0) return false
  try {
    let mem = (await readGlobalMemoryContent()) ?? '# 全局记忆\n'
    const entries = lessons.map((l) => `- ⚠️ ${normalizeMistake(l)}`)
    mem = upsertSection(mem, GLOBAL_LESSON_HEADER, entries, true)
    const r = await writeGlobalMemoryContent(mem)
    return r.ok
  } catch {
    return false
  }
}

// 把绩效档案 + 错题本写进岗位 MEMORY.md（best-effort）。
// §13.5：通用教训另升全局。§13.6：错题本按 cleanStreak 老化/毕业。
// aging=false（人工校准等非任务周期）：只更新绩效，不推进错题 clean，避免干扰老化节奏（§B5-3）。
export async function writeSeatMemory(
  workspaceRoot: string | null,
  perfSection: string,
  mistakeEntries: string[],
  aging = true
): Promise<boolean> {
  if (!workspaceRoot) return false
  try {
    await ensureProjectMemory(workspaceRoot)
    let memory = (await readProjectMemoryContent(workspaceRoot)) ?? ''
    memory = upsertSection(memory, PERF_HEADER, perfSection.split('\n').slice(1))
    // 拆分项目级 / 通用级教训（§13.5）。
    const { project, global } = splitLessons(mistakeEntries.map((e) => e.replace(/^-\s*❌\s*/, '')))
    // 一步完成：插入项目级新坑 + 按本周期活跃坑（project+global）老化/毕业（§13.4+§13.6）。
    memory = mergeAndAgeMistakes(memory, project, [...project, ...global], aging)
    const r = await writeProjectMemoryContent(workspaceRoot, memory)
    // 通用教训升全局（§13.5）。
    if (global.length) await promoteGlobalLessons(global)
    return r.ok
  } catch {
    return false
  }
}

// 调主管引擎打分（best-effort，失败回退 fallbackScore）。
export async function scoreSeats(inputs: SeatReviewInput[], period: string): Promise<RawScore[]> {
  const profileId = getActiveProfileId()
  const profile = profileId ? getProfileRaw(profileId) : null
  if (!profile || inputs.length === 0) return inputs.map(fallbackScore)
  try {
    const adapter = createAdapter(profile, getActiveProfileApiKey())
    const messages = buildReviewMessages(inputs, period)
    let text = ''
    for await (const chunk of adapter.streamChat({ model: profile.model, messages, maxOutputTokens: 2048 }, undefined)) {
      if (chunk.type === 'text') text += chunk.text
    }
    const scores = parseScores(text)
    // 缺失的岗位用 fallback 补齐。
    return inputs.map((i) => scores.find((s) => s.seatId === i.seatId) ?? fallbackScore(i))
  } catch {
    return inputs.map(fallbackScore)
  }
}

export { PERF_HEADER, MISTAKE_HEADER, MASTERED_HEADER, GLOBAL_LESSON_HEADER }
export type { RawScore }
