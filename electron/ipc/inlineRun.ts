import { ipcMain, WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { spawn, type ChildProcess } from 'child_process'
import { killProcessTree, shellInvocation } from '../services/headlessTerminal'

/**
 * Inline run service: spawns a command via child_process and streams its
 * stdout/stderr to the renderer over IPC, so the chat stream can show live
 * run output without switching to the IDE terminal. Distinct from the user's
 * PTY terminal (ipc/terminal.ts) and the agent's background tasks.
 */

interface RunSession {
  id: string
  child: ChildProcess
  wc: WebContents
  exited: boolean
}

const sessions = new Map<string, RunSession>()

interface StartResult {
  ok: boolean
  id?: string
  error?: string
}

function disposeSessionsForWebContents(target: WebContents): void {
  for (const id of [...sessions.keys()]) {
    const s = sessions.get(id)
    if (s?.wc === target) {
      if (!s.exited) killProcessTree(s.child)
      sessions.delete(id)
    }
  }
}

export function killAllInlineRuns(): void {
  for (const s of sessions.values()) {
    if (!s.exited) killProcessTree(s.child)
  }
  sessions.clear()
}

export function registerInlineRunIpc(): void {
  ipcMain.handle(
    'run:start',
    (e, command: string, cwd: string): StartResult => {
      if (!command || typeof command !== 'string') {
        return { ok: false, error: '无效的运行命令' }
      }
      const safeCwd = cwd && existsSync(cwd) ? cwd : homedir()
      const id = randomUUID()
      const wc = e.sender

      try {
        const { file, args } = shellInvocation(command)
        const child = spawn(file, args, {
          cwd: safeCwd,
          env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...process.env },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })

        const session: RunSession = { id, child, wc, exited: false }
        sessions.set(id, session)

        if (!wc.isDestroyed()) {
          wc.once('destroyed', () => disposeSessionsForWebContents(wc))
        }

        child.stdout?.on('data', (chunk: Buffer) => {
          if (!wc.isDestroyed()) wc.send('run:data', { id, data: chunk.toString('utf8'), stream: 'stdout' })
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          if (!wc.isDestroyed()) wc.send('run:data', { id, data: chunk.toString('utf8'), stream: 'stderr' })
        })
        child.on('error', (err) => {
          session.exited = true
          if (!wc.isDestroyed()) {
            wc.send('run:data', { id, data: `\n[运行失败] ${err.message}\n`, stream: 'stderr' })
            wc.send('run:exit', { id, exitCode: null, error: err.message })
          }
          sessions.delete(id)
        })
        child.on('close', (code, signal) => {
          session.exited = true
          if (!wc.isDestroyed()) {
            wc.send('run:exit', { id, exitCode: code, signal: signal ?? undefined })
          }
          sessions.delete(id)
        })

        return { ok: true, id }
      } catch (err) {
        sessions.delete(id)
        return { ok: false, error: err instanceof Error ? err.message : '运行启动失败' }
      }
    }
  )

  ipcMain.handle('run:input', (_e, id: string, data: string): boolean => {
    const s = sessions.get(id)
    if (!s || s.exited || !s.child.stdin || s.child.stdin.destroyed) return false
    try {
      s.child.stdin.write(data)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('run:stop', (_e, id: string): boolean => {
    const s = sessions.get(id)
    if (!s) return false
    if (!s.exited) killProcessTree(s.child)
    return true
  })
}
