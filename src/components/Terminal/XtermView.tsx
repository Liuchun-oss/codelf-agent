import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { TerminalTab } from '@/stores/terminalStore'
import { cssVar, onThemeChange } from '@/stores/themeStore'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu'

interface Props {
  session: TerminalTab
  visible: boolean
}

/** Builds the xterm color theme from the active CSS theme variables so the
 *  terminal follows the in-app appearance settings. ANSI colors stay fixed. */
function buildTheme(): Record<string, string> {
  const bg = cssVar('--bg-elevated', '#181818')
  const fg = cssVar('--text', '#cccccc')
  return {
    background: bg,
    foreground: fg,
    cursor: cssVar('--accent-bright', '#ffffff'),
    cursorAccent: bg,
    selectionBackground: 'rgba(120, 160, 200, 0.35)',
    black: '#181818',
    red: '#f14c4c',
    green: '#23d18b',
    yellow: '#f5f543',
    blue: '#3b8eea',
    magenta: '#d670d6',
    cyan: '#29b8db',
    white: '#cccccc',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff'
  }
}

export default function XtermView({ session, visible }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

  
  
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: buildTheme(),
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      allowProposedApi: true,
      rightClickSelectsWord: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(el)
    termRef.current = term
    fitRef.current = fit

    const doFit = (): void => {
      const node = containerRef.current
      if (!node || node.clientWidth === 0 || node.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        return
      }
      void window.lc.terminalResize(session.id, term.cols, term.rows)
    }

    const inputDisp = term.onData((data) => {
      void window.lc.terminalWrite(session.id, data)
    })

    const offData = window.lc.onTerminalData((p) => {
      if (p.id === session.id) term.write(p.data)
    })
    const offExit = window.lc.onTerminalExit((p) => {
      if (p.id !== session.id) return
      const code = p.exitCode ?? 0
      term.write(`\r\n\x1b[90m[进程已退出，退出码 ${code}。可关闭该终端标签。]\x1b[0m\r\n`)
    })

    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      term.focus()
      setCtxMenu({ x: e.clientX, y: e.clientY })
    }
    const onMouseDown = (): void => {
      term.focus()
    }

    el.addEventListener('contextmenu', onContextMenu)
    el.addEventListener('mousedown', onMouseDown)

    const ro = new ResizeObserver(() => doFit())
    ro.observe(el)

    void window.lc.terminalAttach(session.id)

    const offTheme = onThemeChange(() => {
      term.options.theme = buildTheme()
    })

    requestAnimationFrame(doFit)

    return () => {
      ro.disconnect()
      inputDisp.dispose()
      offData()
      offExit()
      offTheme()
      el.removeEventListener('contextmenu', onContextMenu)
      el.removeEventListener('mousedown', onMouseDown)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [session.id])

  useEffect(() => {
    if (!visible) return
    const term = termRef.current
    const fit = fitRef.current
    const node = containerRef.current
    if (!term || !fit || !node) return
    requestAnimationFrame(() => {
      if (node.clientWidth === 0 || node.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        return
      }
      void window.lc.terminalResize(session.id, term.cols, term.rows)
      term.focus()
    })
  }, [visible, session.id])

  const contextItems: MenuItem[] = (() => {
    const term = termRef.current
    const hasSelection = Boolean(term?.hasSelection())
    return [
      {
        label: '复制',
        shortcut: 'Ctrl+C',
        disabled: !hasSelection,
        onClick: () => {
          const text = term?.getSelection()
          if (text) void window.lc.clipboardWriteText(text)
        }
      },
      {
        label: '粘贴',
        shortcut: 'Ctrl+V',
        onClick: () => {
          void window.lc.clipboardReadText().then((text) => {
            if (text && term) term.paste(text)
          })
        }
      },
      { separator: true },
      {
        label: '全选',
        shortcut: 'Ctrl+A',
        onClick: () => term?.selectAll()
      },
      {
        label: '清除选区',
        disabled: !hasSelection,
        onClick: () => term?.clearSelection()
      }
    ]
  })()

  return (
    <>
      <div
        ref={containerRef}
        className="xterm-host"
        style={{ display: visible ? 'block' : 'none' }}
      />
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={contextItems}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  )
}
