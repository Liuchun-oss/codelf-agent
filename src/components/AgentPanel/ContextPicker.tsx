import { useEffect, useMemo, useRef, useState } from 'react'
import type { RuleSummary } from '@shared/agentTypes'
import { fuzzyRank } from '@/utils/fuzzy'
import { basename } from '@/utils/path'
import FileIcon from '@/components/common/FileIcon'
import { shouldConsumePickSignal } from './pickTrigger'

export type PickKind = 'file' | 'folder' | 'rule'


export interface PickItem {
  kind: PickKind
  
  id: string
  name: string
  ruleBody?: string
}

interface Row {
  id: string
  name: string
  rel: string
  dir?: string
  kind: PickKind
  ruleBody?: string
  ruleDescription?: string
}

function rowToItem(row: Row): PickItem {
  return { kind: row.kind, id: row.id, name: row.name, ruleBody: row.ruleBody }
}

export interface ContextPickerProps {
  query: string
  workspaceRoot: string
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onPick: (item: PickItem) => void
  
  pickSignal?: number
  
  onRowCountChange?: (count: number) => void
}


export default function ContextPicker({
  query,
  workspaceRoot,
  activeIndex,
  onActiveIndexChange,
  onPick,
  pickSignal = 0,
  onRowCountChange
}: ContextPickerProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<Row[]>([])
  const activeIndexRef = useRef(activeIndex)
  const onPickRef = useRef(onPick)
  const lastPickSignalRef = useRef(0)
  const [files, setFiles] = useState<string[]>([])
  const [rules, setRules] = useState<RuleSummary[]>([])
  const [loading, setLoading] = useState(true)

  activeIndexRef.current = activeIndex
  onPickRef.current = onPick

  useEffect(() => {
    let alive = true
    setLoading(true)
    void Promise.all([
      window.lc.listFiles(workspaceRoot),
      window.lc.aiListRules(workspaceRoot).catch(() => [] as RuleSummary[])
    ]).then(([list, ruleList]) => {
      if (!alive) return
      setFiles(list)
      setRules(ruleList)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [workspaceRoot])

  
  interface Entry {
    id: string
    rel: string
    kind: PickKind
    ruleBody?: string
    ruleDescription?: string
  }
  const entries = useMemo<Entry[]>(() => {
    const rootLen = workspaceRoot.length + 1
    const ruleEntries: Entry[] = rules.map((r) => ({
      id: `rule:${r.name}`,
      rel: r.name,
      kind: 'rule' as const,
      ruleBody: r.body,
      ruleDescription: r.description
    }))
    const fileEntries: Entry[] = files.map((f) => ({
      id: f,
      rel: f.slice(rootLen),
      kind: 'file' as const
    }))
    const dirSet = new Map<string, string>()
    for (const f of files) {
      const rel = f.slice(rootLen)
      const parts = rel.split(/[\\/]/)
      parts.pop() 
      let accRel = ''
      let accAbs = workspaceRoot
      for (const seg of parts) {
        if (!seg) continue
        accRel = accRel ? `${accRel}/${seg}` : seg
        accAbs = `${accAbs}/${seg}`
        if (!dirSet.has(accRel)) dirSet.set(accRel, accAbs)
      }
    }
    const dirEntries: Entry[] = [...dirSet.entries()].map(([rel, absPath]) => ({
      id: absPath,
      rel,
      kind: 'folder' as const
    }))
    return [...ruleEntries, ...dirEntries, ...fileEntries]
  }, [files, rules, workspaceRoot])

  const rows = useMemo<Row[]>(() => {
    const ranked = fuzzyRank(query, entries, (e) => e.rel, 80)
    return ranked.map(({ item }) => {
      const name = item.kind === 'rule' ? item.rel : basename(item.rel) || item.rel
      const dir =
        item.kind === 'rule'
          ? undefined
          : item.rel.slice(0, Math.max(0, item.rel.length - name.length - 1))
      return {
        id: item.id,
        name,
        rel: item.rel,
        dir: dir || undefined,
        kind: item.kind,
        ruleBody: item.ruleBody,
        ruleDescription: item.ruleDescription
      }
    })
  }, [query, entries])

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
    if (row) onPickRef.current(rowToItem(row))
  }, [pickSignal])

  return (
    <div className="agent-context-picker" role="listbox" aria-label="附加文件">
      {loading ? (
        <div className="agent-context-picker-empty">加载文件列表…</div>
      ) : rows.length === 0 ? (
        <div className="agent-context-picker-empty">无匹配文件</div>
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
                onPick(rowToItem(row))
              }}
            >
              <span className="agent-context-picker-icon">
                {row.kind === 'folder' ? '📁' : row.kind === 'rule' ? '📏' : <FileIcon name={row.name} />}
              </span>
              <span className="agent-context-picker-primary">
                {row.name}
                {row.kind === 'folder' ? '/' : ''}
              </span>
              {row.kind === 'rule' && row.ruleDescription && (
                <span className="agent-context-picker-secondary">{row.ruleDescription}</span>
              )}
              {row.kind === 'rule' && !row.ruleDescription && (
                <span className="agent-context-picker-secondary">rule</span>
              )}
              {row.kind !== 'rule' && row.dir && (
                <span className="agent-context-picker-secondary">{row.dir}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
