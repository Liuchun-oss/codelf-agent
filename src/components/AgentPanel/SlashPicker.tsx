import { useEffect, useMemo, useRef, useState } from 'react'
import type { SkillDetail } from '@shared/skillTypes'
import type { InstalledPluginInfo } from '@shared/pluginTypes'
import { fuzzyRank } from '@/utils/fuzzy'
import { shouldConsumePickSignal } from './pickTrigger'

export type SlashKind = 'skill' | 'plugin' | 'action'

/** 动作型指令 id（立即执行，非引用）。 */
export type SlashActionId = 'compact'

export interface SlashItem {
  kind: SlashKind
  /** 唯一 id（kind + name） */
  id: string
  /** skill 名 或 插件名 / action 名 */
  name: string
  /** 展示用副标题（skill 描述 / 插件携带内容概览 / action 说明） */
  description?: string
  /** 插件携带的 skill 名（plugin 专用） */
  pluginSkills?: string[]
  /** 插件携带的 MCP server 名（plugin 专用） */
  pluginMcpServers?: string[]
  /** action 专用：具体动作标识 */
  action?: SlashActionId
}

/** 内置动作型指令：立即执行，不塞进输入框。 */
const ACTION_ITEMS: SlashItem[] = [
  {
    kind: 'action',
    id: 'action:compact',
    name: 'compact',
    description: '压缩当前对话的早期上下文，释放空间并保留摘要',
    action: 'compact'
  }
]

interface Row extends SlashItem {
  label: string
}

export interface SlashPickerProps {
  query: string
  workspaceRoot?: string
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onPick: (item: SlashItem) => void
  pickSignal?: number
  onRowCountChange?: (count: number) => void
}

export default function SlashPicker({
  query,
  workspaceRoot,
  activeIndex,
  onActiveIndexChange,
  onPick,
  pickSignal = 0,
  onRowCountChange
}: SlashPickerProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<Row[]>([])
  const activeIndexRef = useRef(activeIndex)
  const onPickRef = useRef(onPick)
  const lastPickSignalRef = useRef(0)
  const [skills, setSkills] = useState<SkillDetail[]>([])
  const [plugins, setPlugins] = useState<InstalledPluginInfo[]>([])
  const [loading, setLoading] = useState(true)

  activeIndexRef.current = activeIndex
  onPickRef.current = onPick

  useEffect(() => {
    let alive = true
    setLoading(true)
    void Promise.all([
      window.lc.skills.list(workspaceRoot ?? null).catch(() => [] as SkillDetail[]),
      window.lc.plugins.list().catch(() => [] as InstalledPluginInfo[])
    ]).then(([skillList, pluginList]) => {
      if (!alive) return
      setSkills(skillList.filter((s) => s.enabled))
      setPlugins(pluginList)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [workspaceRoot])

  const items = useMemo<SlashItem[]>(() => {
    const pluginItems: SlashItem[] = plugins.map((p) => {
      const parts: string[] = []
      if (p.skills.length > 0) parts.push(`skill: ${p.skills.join(', ')}`)
      if (p.mcpServers.length > 0) parts.push(`MCP: ${p.mcpServers.join(', ')}`)
      return {
        kind: 'plugin' as const,
        id: `plugin:${p.pluginName}`,
        name: p.pluginName,
        description: p.description || parts.join(' · ') || '插件',
        pluginSkills: p.skills,
        pluginMcpServers: p.mcpServers
      }
    })
    // 属于某插件的子技能：只通过插件本体引用，不在独立技能里重复展示。
    const pluginSkillNames = new Set(
      plugins.flatMap((p) => p.skills.map((s) => s.toLowerCase()))
    )
    const skillItems: SlashItem[] = skills
      .filter((s) => !pluginSkillNames.has(s.name.toLowerCase()))
      .map((s) => ({
        kind: 'skill' as const,
        id: `skill:${s.name}`,
        name: s.name,
        description: s.description
      }))
    // 动作型指令排在最前，便于快速触发。
    return [...ACTION_ITEMS, ...pluginItems, ...skillItems]
  }, [skills, plugins])

  const rows = useMemo<Row[]>(() => {
    const ranked = fuzzyRank(query, items, (e) => e.name, 80)
    return ranked.map(({ item }) => ({ ...item, label: item.name }))
  }, [query, items])

  rowsRef.current = rows

  useEffect(() => {
    onRowCountChange?.(rows.length)
  }, [rows.length, onRowCountChange])

  useEffect(() => {
    if (rows.length === 0) {
      if (activeIndex !== 0) onActiveIndexChange(0)
      return
    }
    if (activeIndex >= rows.length) onActiveIndexChange(rows.length - 1)
  }, [rows.length, activeIndex, onActiveIndexChange])

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, rows.length])

  useEffect(() => {
    if (!shouldConsumePickSignal(pickSignal, lastPickSignalRef.current)) return
    lastPickSignalRef.current = pickSignal
    const r = rowsRef.current
    if (r.length === 0) return
    const idx = Math.min(activeIndexRef.current, r.length - 1)
    const row = r[idx]
    if (row) onPickRef.current(row)
  }, [pickSignal])

  return (
    <div className="agent-context-picker" role="listbox" aria-label="斜线命令">
      {loading ? (
        <div className="agent-context-picker-empty">加载技能与插件…</div>
      ) : rows.length === 0 ? (
        <div className="agent-context-picker-empty">无匹配的技能或插件</div>
      ) : (
        <div className="agent-context-picker-list" ref={listRef}>
          {rows.map((row, i) => (
            <div
              key={row.id}
              role="option"
              aria-selected={i === activeIndex}
              className={`agent-context-picker-item${i === activeIndex ? ' active' : ''}`}
              onMouseEnter={() => onActiveIndexChange(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(row)
              }}
            >
              <span className="agent-context-picker-icon">
                {row.kind === 'action' ? '🗜️' : row.kind === 'plugin' ? '🧩' : '⚡'}
              </span>
              <span className="agent-context-picker-primary">{row.label}</span>
              <span className="agent-slash-kind">
                {row.kind === 'action' ? '指令' : row.kind === 'plugin' ? '插件' : '技能'}
              </span>
              {row.description && (
                <span className="agent-context-picker-secondary">{row.description}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
