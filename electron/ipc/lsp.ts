import { app, ipcMain, WebContents } from 'electron'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'




export type LspServerId = 'python' | 'typescript' | 'css' | 'html' | 'json' | 'yaml' | 'vue'

interface Server {
  id: LspServerId
  proc: ChildProcessWithoutNullStreams
  wc: WebContents
  buffer: Buffer
  contentLength: number
  intentionalStop: boolean
}

interface ServerDef {
  resolveEntry: () => string | null
  args: string[]
  
  needsCwd: boolean
  missingHint: string
}


function resolveModuleEntry(specifier: string): string | null {
  try {
    let entry = require.resolve(specifier)
    if (app.isPackaged && entry.includes('app.asar')) {
      const unpacked = entry.replace('app.asar', 'app.asar.unpacked')
      if (existsSync(unpacked)) entry = unpacked
    }
    return entry
  } catch {
    return null
  }
}

const SERVER_DEFS: Record<LspServerId, ServerDef> = {
  python: {
    resolveEntry: () => resolveModuleEntry('basedpyright/langserver.index.js'),
    args: ['--stdio'],
    needsCwd: false,
    missingHint: 'basedpyright 未安装（请运行 npm install basedpyright）'
  },
  typescript: {
    resolveEntry: () => resolveModuleEntry('typescript-language-server/lib/cli.mjs'),
    args: ['--stdio'],
    needsCwd: true,
    missingHint: 'typescript-language-server 未安装（请运行 npm install typescript-language-server）'
  },
  css: {
    resolveEntry: () =>
      resolveModuleEntry('vscode-langservers-extracted/lib/css-language-server/node/cssServerMain.js'),
    args: ['--stdio'],
    needsCwd: false,
    missingHint: 'CSS 语言服务未安装（请运行 npm install vscode-langservers-extracted）'
  },
  html: {
    resolveEntry: () =>
      resolveModuleEntry('vscode-langservers-extracted/lib/html-language-server/node/htmlServerMain.js'),
    args: ['--stdio'],
    needsCwd: false,
    missingHint: 'HTML 语言服务未安装（请运行 npm install vscode-langservers-extracted）'
  },
  json: {
    resolveEntry: () =>
      resolveModuleEntry('vscode-langservers-extracted/lib/json-language-server/node/jsonServerMain.js'),
    args: ['--stdio'],
    needsCwd: false,
    missingHint: 'JSON 语言服务未安装（请运行 npm install vscode-langservers-extracted）'
  },
  yaml: {
    resolveEntry: () => resolveModuleEntry('yaml-language-server/out/server/src/server.js'),
    args: ['--stdio'],
    needsCwd: false,
    missingHint: 'YAML 语言服务未安装（请运行 npm install yaml-language-server）'
  },
  vue: {
    resolveEntry: () => resolveModuleEntry('@vue/language-server/index.js'),
    args: ['--stdio'],
    needsCwd: true,
    missingHint: 'Vue 语言服务未安装（请运行 npm install @vue/language-server）'
  }
}

const servers = new Map<LspServerId, Server>()

function frame(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, json])
}

function handleStdout(s: Server, chunk: Buffer): void {
  s.buffer = Buffer.concat([s.buffer, chunk])
  for (;;) {
    if (s.contentLength < 0) {
      const headerEnd = s.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = s.buffer.subarray(0, headerEnd).toString('ascii')
      const m = /Content-Length:\s*(\d+)/i.exec(header)
      s.buffer = s.buffer.subarray(headerEnd + 4)
      if (!m) continue
      s.contentLength = parseInt(m[1], 10)
    }
    if (s.buffer.length < s.contentLength) return
    const body = s.buffer.subarray(0, s.contentLength).toString('utf8')
    s.buffer = s.buffer.subarray(s.contentLength)
    s.contentLength = -1
    try {
      const msg = JSON.parse(body)
      if (!s.wc.isDestroyed()) s.wc.send('lsp:message', { serverId: s.id, message: msg })
    } catch {
      
    }
  }
}

function stopServer(id: LspServerId): void {
  const s = servers.get(id)
  if (!s) return
  s.intentionalStop = true
  servers.delete(id)
  try {
    s.proc.kill()
  } catch {
    
  }
}

function startServer(
  id: LspServerId,
  wc: WebContents,
  workspaceRoot?: string
): { ok: boolean; error?: string } {
  const existing = servers.get(id)
  if (existing && !existing.proc.killed) {
    existing.wc = wc
    return { ok: true }
  }

  const def = SERVER_DEFS[id]
  const entry = def.resolveEntry()
  if (!entry) return { ok: false, error: def.missingHint }

  if (def.needsCwd) {
    if (!workspaceRoot || !existsSync(workspaceRoot)) {
      return { ok: false, error: '请先打开工作区文件夹（TypeScript 需要项目根目录）' }
    }
  }

  try {
    const proc = spawn(process.execPath, [entry, ...def.args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: def.needsCwd ? workspaceRoot : undefined,
      windowsHide: true
    })
    const s: Server = { id, proc, wc, buffer: Buffer.alloc(0), contentLength: -1, intentionalStop: false }
    proc.stdout.on('data', (c: Buffer) => handleStdout(s, c))
    proc.stderr.on('data', (chunk: Buffer) => {
      if (!app.isPackaged) process.stderr.write(`[LSP:${id}] ${chunk.toString()}`)
    })
    proc.on('exit', () => {
      if (servers.get(id) === s) servers.delete(id)
      if (!s.intentionalStop && !s.wc.isDestroyed()) s.wc.send('lsp:closed', { serverId: id })
    })
    proc.on('error', () => {
      if (servers.get(id) === s) servers.delete(id)
    })
    servers.set(id, s)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '语言服务器启动失败' }
  }
}

export function registerLspIpc(): void {
  ipcMain.handle('lsp:tsdkPath', () => {
    try {
      const tsPath = require.resolve('typescript')
      
      return require('path').dirname(tsPath)
    } catch {
      return null
    }
  })

  ipcMain.handle(
    'lsp:start',
    (e, serverId: LspServerId, workspaceRoot?: string) =>
      startServer(serverId, e.sender, workspaceRoot)
  )
  ipcMain.handle('lsp:stop', (_e, serverId: LspServerId) => {
    stopServer(serverId)
    return true
  })
  ipcMain.on('lsp:send', (_e, serverId: LspServerId, message: unknown) => {
    const s = servers.get(serverId)
    if (s && !s.proc.killed) {
      try {
        s.proc.stdin.write(frame(message))
      } catch {
        
      }
    }
  })
}

export function stopAllLsp(): void {
  for (const id of [...servers.keys()]) stopServer(id)
}
