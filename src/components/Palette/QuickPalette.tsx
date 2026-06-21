import { useEffect, useMemo, useRef, useState } from 'react'
import { usePaletteStore } from '@/stores/paletteStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useEditorStore } from '@/stores/editorStore'
import { getCommands, type Command } from '@/commands/commands'
import { fuzzyRank } from '@/utils/fuzzy'
import { basename } from '@/utils/path'
import FileIcon from '@/components/common/FileIcon'
import AnimatedOverlay from '@/components/common/AnimatedOverlay'

interface Row {
  key: string
  icon: JSX.Element | null
  primary: string
  secondary?: string
  trailing?: string
  run: () => void
}

export default function QuickPalette(): JSX.Element | null {
  const mode = usePaletteStore((s) => s.mode)
  const close = usePaletteStore((s) => s.close)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [snapMode, setSnapMode] = useState(mode)

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [files, setFiles] = useState<string[]>([])

  const workspaceRoot = useWorkspaceStore((s) => s.workspace?.path)
  const open = !!mode

  useEffect(() => {
    if (mode) setSnapMode(mode)
  }, [mode])

  useEffect(() => {
    if (!mode) return
    setQuery('')
    setActive(0)
    requestAnimationFrame(() => inputRef.current?.focus())
    if (mode !== 'files' || !workspaceRoot) {
      setFiles([])
      return
    }
    let alive = true
    const root = workspaceRoot
    void window.lc.listFiles(root).then((list) => {
      if (alive) setFiles(list)
    })
    return () => {
      alive = false
    }
  }, [mode, workspaceRoot])

  const rows = useMemo<Row[]>(() => {
    const m = snapMode
    if (m === 'commands') {
      const cmds = getCommands()
      const ranked = fuzzyRank(query, cmds, (c: Command) =>
        `${c.category ?? ''} ${c.title}`.trim()
      )
      return ranked.map(({ item }) => ({
        key: item.id,
        icon: null,
        primary: item.title,
        secondary: item.category,
        trailing: item.shortcut,
        run: () => void item.run()
      }))
    }
    if (m === 'files') {
      const rootLen = workspaceRoot ? workspaceRoot.length + 1 : 0
      const ranked = fuzzyRank(query, files, (f) => f.slice(rootLen), 300)
      return ranked.map(({ item }) => {
        const name = basename(item)
        const rel = item.slice(rootLen)
        const dir = rel.slice(0, Math.max(0, rel.length - name.length - 1))
        return {
          key: item,
          icon: <FileIcon name={name} />,
          primary: name,
          secondary: dir || undefined,
          run: () => void useEditorStore.getState().openFile(item, name)
        }
      })
    }
    return []
  }, [snapMode, query, files, workspaceRoot])

  useEffect(() => {
    setActive(0)
  }, [query, snapMode])

  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!snapMode) return null

  const choose = (row: Row | undefined): void => {
    if (!row) {
      close()
      return
    }
    close()
    row.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(rows[active])
    }
  }

  const placeholder = snapMode === 'commands' ? '输入命令…' : '按文件名搜索…'

  return (
    <AnimatedOverlay
      open={open}
      onClose={close}
      onExited={() => setSnapMode(null)}
      clickOverlayToClose
      overlayClassName="palette-overlay"
      panelClassName="palette"
    >
      <input
        ref={inputRef}
        className="palette-input"
        value={query}
        placeholder={placeholder}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="palette-list" ref={listRef}>
        {rows.length === 0 ? (
          <div className="palette-empty">无匹配项</div>
        ) : (
          rows.map((row, i) => (
            <div
              key={row.key}
              className={`palette-item${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(row)
              }}
            >
              {row.icon && <span className="palette-icon">{row.icon}</span>}
              <span className="palette-primary">{row.primary}</span>
              {row.secondary && <span className="palette-secondary">{row.secondary}</span>}
              {row.trailing && <span className="palette-trailing">{row.trailing}</span>}
            </div>
          ))
        )}
      </div>
    </AnimatedOverlay>
  )
}
