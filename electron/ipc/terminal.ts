import { ipcMain, WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { execFile } from 'child_process'
import * as pty from '@lydell/node-pty'

interface Session {
  id: string
  proc: pty.IPty
  wc: WebContents
  dataDisp: pty.IDisposable
  exitDisp: pty.IDisposable
  exited: boolean
  attached: boolean
  buffer: string[]
}

const sessions = new Map<string, Session>()

function disposeSessionsForWebContents(target: WebContents): void {
  for (const id of [...sessions.keys()]) {
    if (sessions.get(id)?.wc === target) disposeSession(id)
  }
}

interface CreateResult {
  ok: boolean
  id?: string
  title?: string
  cwd?: string
  error?: string
}

function resolveShell(): { file: string; args: string[]; title: string } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'], title: 'PowerShell' }
  }
  const shell = process.env.SHELL || '/bin/bash'
  return { file: shell, args: [], title: shell.split('/').pop() || 'shell' }
}


function utf8InitCommand(): string | null {
  if (process.platform !== 'win32') return null
  return [
    'chcp 65001 > $null',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    '$OutputEncoding=[System.Text.Encoding]::UTF8',
    'Clear-Host'
  ].join('; ')
}

function killProcessTree(proc: pty.IPty): void {
  const pid = proc.pid
  if (process.platform === 'win32' && pid > 0) {
    
    
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {})
    return
  }
  try {
    proc.kill()
  } catch {
    
  }
}

function disposeSession(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.dataDisp.dispose()
    s.exitDisp.dispose()
  } catch {
    
  }
  if (!s.exited) {
    killProcessTree(s.proc)
  }
  sessions.delete(id)
}

export function killAllTerminals(): void {
  for (const id of [...sessions.keys()]) disposeSession(id)
}

export function registerTerminalIpc(): void {
  ipcMain.handle(
    'terminal:create',
    (e, cwd: string, cols?: number, rows?: number): CreateResult => {
      const safeCwd = cwd && existsSync(cwd) ? cwd : homedir()
      const { file, args, title } = resolveShell()
      const id = randomUUID()

      try {
        const proc = pty.spawn(file, args, {
          name: 'xterm-256color',
          cwd: safeCwd,
          cols: cols && cols > 0 ? Math.floor(cols) : 80,
          rows: rows && rows > 0 ? Math.floor(rows) : 24,
          env: { ...process.env, TERM: 'xterm-256color' }
        })

        const wc = e.sender
        if (!wc.isDestroyed()) {
          wc.once('destroyed', () => disposeSessionsForWebContents(wc))
        }
        
        const dataDisp = proc.onData((data) => {
          const s = sessions.get(id)
          if (!s) return
          if (s.attached) {
            if (!wc.isDestroyed()) wc.send('terminal:data', { id, data })
          } else {
            s.buffer.push(data)
            if (s.buffer.length > 4000) s.buffer.shift()
          }
        })
        const exitDisp = proc.onExit(({ exitCode }) => {
          const s = sessions.get(id)
          if (s) s.exited = true
          if (!wc.isDestroyed()) wc.send('terminal:exit', { id, exitCode })
          disposeSession(id)
        })

        sessions.set(id, {
          id,
          proc,
          wc,
          dataDisp,
          exitDisp,
          exited: false,
          attached: false,
          buffer: []
        })

        const init = utf8InitCommand()
        if (init) proc.write(init + '\r')

        return { ok: true, id, title, cwd: safeCwd }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '终端启动失败' }
      }
    }
  )

  ipcMain.handle('terminal:attach', (_e, id: string): boolean => {
    const s = sessions.get(id)
    if (!s) return false
    if (s.buffer.length && !s.wc.isDestroyed()) {
      s.wc.send('terminal:data', { id, data: s.buffer.join('') })
    }
    s.buffer = []
    s.attached = true
    return true
  })

  ipcMain.handle('terminal:write', (_e, id: string, data: string): boolean => {
    const s = sessions.get(id)
    if (!s || s.exited) return false
    try {
      s.proc.write(data)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('terminal:resize', (_e, id: string, cols: number, rows: number): boolean => {
    const s = sessions.get(id)
    if (!s || s.exited) return false
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return false
    try {
      s.proc.resize(Math.floor(cols), Math.floor(rows))
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('terminal:kill', (_e, id: string): boolean => {
    if (!sessions.has(id)) return false
    disposeSession(id)
    return true
  })
}
