import { spawn, type ChildProcess } from 'child_process'



export interface HeadlessRunOptions {
  cwd: string
  
  timeoutMs?: number
  
  env?: Record<string, string>
  
  maxOutputChars?: number
  
  signal?: AbortSignal
  
  onData?: (chunk: string, stream: 'stdout' | 'stderr') => void
}

export interface HeadlessRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  
  killedBySignal?: string
  
  truncated: boolean
  
  awaitingInput?: boolean
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT = 1024 * 1024

const INTERACTIVE_IDLE_MS = 10_000

const INTERACTIVE_PROMPT_RE =
  /(\[y\/n\]|\(y\/n\)|\[yes\/no\]|\(yes\/no\)|\by\/n\b|是否继续|password\s*[:：]|passphrase\s*[:：]|press\s+(any\s+key|enter|return)|按(任意键|回车))\s*$/i

export function currentShellName(): string {
  return process.platform === 'win32' ? 'Windows PowerShell' : process.env.SHELL || '/bin/bash'
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function decodePowerShellEscapes(text: string): string {
  return text.replace(/_x([0-9a-fA-F]{4})_/g, (_m, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  )
}

function decodePowerShellCliXml(text: string): string {
  if (!text.trimStart().startsWith('#< CLIXML')) return text
  const messages = [...text.matchAll(/<S\b[^>]*>([\s\S]*?)<\/S>/g)].map((m) =>
    decodePowerShellEscapes(decodeXmlEntities(m[1]))
  )
  if (messages.length > 0) return messages.join('')
  if (/<Obj\b[^>]*\bS="progress"/.test(text)) return ''
  return text
}

function splitPowerShellAnd(command: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quote: 'single' | 'double' | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    const next = command[i + 1]
    if (quote === 'single') {
      cur += ch
      if (ch === "'") quote = null
      continue
    }
    if (quote === 'double') {
      cur += ch
      if (ch === '`' && next) {
        cur += next
        i++
        continue
      }
      if (ch === '"') quote = null
      continue
    }
    if (ch === "'") {
      quote = 'single'
      cur += ch
      continue
    }
    if (ch === '"') {
      quote = 'double'
      cur += ch
      continue
    }
    if (ch === '&' && next === '&') {
      parts.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
  }
  parts.push(cur.trim())
  return parts.filter((p) => p.length > 0)
}

function normalizeCommandForCurrentShell(command: string): string {
  if (process.platform !== 'win32' || !command.includes('&&')) return command
  const parts = splitPowerShellAnd(command)
  if (parts.length <= 1) return command
  const [first, ...rest] = parts
  return [first, ...rest.map((part) => `if ($?) { ${part} }`)].join('; ')
}


export function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      return
    } catch {
      
    }
  }
  child.kill('SIGKILL')
}

export function shellInvocation(command: string): { file: string; args: string[] } {
  const shellCommand = normalizeCommandForCurrentShell(command)
  if (process.platform === 'win32') {
    
    
    
    const script = [
      'chcp 65001 > $null',
      "$ProgressPreference='SilentlyContinue'",
      '[Console]::InputEncoding=[System.Text.Encoding]::UTF8',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      '$OutputEncoding=[System.Text.Encoding]::UTF8',
      shellCommand,
      'exit $LASTEXITCODE'
    ].join('; ')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
    }
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-lc', shellCommand] }
}


export function runCommand(command: string, opts: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cap = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT
  const { file, args } = shellInvocation(command)

  return new Promise<HeadlessRunResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let awaitingInput = false
    let settled = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...process.env, ...(opts.env ?? {}) },
      windowsHide: true
    })

    
    const looksLikePrompt = (): boolean => {
      const combined = stdout + stderr
      
      if (/\n[ \t]*$/.test(combined) || combined.endsWith('\n')) return false
      const lastLine = combined.split('\n').pop() ?? ''
      return INTERACTIVE_PROMPT_RE.test(lastLine.trim())
    }

    
    const armIdleDetection = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (settled) return
        if (looksLikePrompt()) {
          awaitingInput = true
          killProcessTree(child)
        }
      }, INTERACTIVE_IDLE_MS)
    }

    const append = (cur: string, chunk: Buffer): string => {
      if (cur.length >= cap) {
        truncated = true
        return cur
      }
      const next = cur + chunk.toString('utf8')
      if (next.length > cap) {
        truncated = true
        return next.slice(0, cap)
      }
      return next
    }

    child.stdout?.on('data', (b: Buffer) => {
      const before = stdout.length
      stdout = append(stdout, b)
      if (opts.onData && stdout.length > before) opts.onData(stdout.slice(before), 'stdout')
      armIdleDetection()
    })
    child.stderr?.on('data', (b: Buffer) => {
      const before = stderr.length
      stderr = append(stderr, b)
      if (opts.onData && stderr.length > before) opts.onData(stderr.slice(before), 'stderr')
      armIdleDetection()
    })

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)

    const onAbort = (): void => {
      killProcessTree(child)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (result: HeadlessRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (idleTimer) clearTimeout(idleTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }

    child.on('error', (err) => {
      finish({
        exitCode: null,
        stdout: decodePowerShellCliXml(stdout),
        stderr: decodePowerShellCliXml(
          stderr + (stderr ? '\n' : '') + (err instanceof Error ? err.message : String(err))
        ),
        timedOut,
        truncated,
        awaitingInput
      })
    })

    child.on('close', (code, signal) => {
      finish({
        exitCode: code,
        stdout: decodePowerShellCliXml(stdout),
        stderr: decodePowerShellCliXml(stderr),
        timedOut,
        killedBySignal: signal ?? undefined,
        truncated,
        awaitingInput
      })
    })
  })
}
