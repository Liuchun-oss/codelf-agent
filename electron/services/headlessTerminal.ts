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
  
  // 因用户停止（AbortSignal）而终止，而非超时或正常结束。
  cancelled?: boolean
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT = 1024 * 1024

// kill 之后等子进程自然退出的宽限期。Windows 的 taskkill 是异步且无回执的，
// 若被安全软件拦截或权限不足，子进程的 close 事件不会到来，工具调用就会一直挂着。
// 超过这个时间强制收尾，保证「停止」一定能结束。
const KILL_GRACE_MS = 1_500

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

function escapePowerShellSingleQuotedHereString(text: string): string {
  return text.replace(/'@/g, "'`@")
}

// POSIX 上让子进程自成进程组：配合 killProcessTree 的组 kill 才能回收整棵子树。
// Windows 不加（会另起控制台，且 taskkill /T 已能杀树）。
export const DETACHED_GROUP: boolean = process.platform !== 'win32'

// 活跃的前台 headless 子进程（run_terminal_cmd / hook 之外的同步命令）。
// 主进程退出时统一回收，避免它们连同孙进程一起变成孤儿。
const activeChildren = new Set<ChildProcess>()

export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) {
    child.kill('SIGKILL')
    return
  }
  if (process.platform === 'win32') {
    // taskkill 异步且无回执：自身报错或非 0 退出（权限不足、被安全软件拦截）时
    // 退回直接终止子进程，避免「进程没死 → close 不来 → 工具永远挂着」。
    let fellBack = false
    const fallbackKill = (): void => {
      if (fellBack) return
      fellBack = true
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程可能已自行退出，忽略。
      }
    }
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.on('error', fallbackKill)
      killer.on('exit', (code) => {
        if (code !== 0) fallbackKill()
      })
      return
    } catch {
      // spawn taskkill 本身失败，落到下面的兜底。
    }
    fallbackKill()
    return
  }
  // POSIX：spawn 时加了 DETACHED_GROUP，子进程即组长，负 pid 精确命中它自己的组。
  // 组已不存在（ESRCH）等异常时退回只杀直接子进程，绝不向未知组发信号。
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    
  }
  try {
    child.kill('SIGKILL')
  } catch {
    
  }
}

export function resetHeadlessRuns(): void {
  for (const child of activeChildren) killProcessTree(child)
  activeChildren.clear()
}

export function shellInvocation(command: string): { file: string; args: string[] } {
  const shellCommand = normalizeCommandForCurrentShell(command)
  if (process.platform === 'win32') {
    
    
    
    const escapedCommand = escapePowerShellSingleQuotedHereString(shellCommand)
    const script = [
      'chcp 65001 > $null',
      "$ProgressPreference='SilentlyContinue'",
      '[Console]::InputEncoding=[System.Text.Encoding]::UTF8',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      '$OutputEncoding=[System.Text.Encoding]::UTF8',
      '$__codelf_exitCode = 0',
      `$__codelf_command = @'\n${escapedCommand}\n'@`,
      'try { & ([scriptblock]::Create($__codelf_command)) | Out-Default } catch { Write-Error $_; $__codelf_exitCode = 1 }',
      'if ($__codelf_exitCode -eq 0) { if ($LASTEXITCODE -is [int]) { $__codelf_exitCode = $LASTEXITCODE } elseif (-not $?) { $__codelf_exitCode = 1 } }',
      'exit $__codelf_exitCode'
    ].join('\n')
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

  // 已取消：直接返回，不启动进程。AbortSignal 只在 abort 那一刻派发一次事件，
  // 之后注册的监听器永远不会触发——若照常 spawn，这个子进程会完全无视本次停止，
  // 一路跑满 timeoutMs（PowerShell 默认 120s、最长 10min），表现为「点了停止还在跑」。
  if (opts.signal?.aborted) {
    return Promise.resolve({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      cancelled: true
    })
  }

  const { file, args } = shellInvocation(command)

  return new Promise<HeadlessRunResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let awaitingInput = false
    let cancelled = false
    let settled = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let killGraceTimer: ReturnType<typeof setTimeout> | null = null

    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...process.env, ...(opts.env ?? {}) },
      windowsHide: true,
      detached: DETACHED_GROUP
    })
    activeChildren.add(child)

    
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
      scheduleForceFinish()
    }, timeoutMs)

    const onAbort = (): void => {
      cancelled = true
      killProcessTree(child)
      scheduleForceFinish()
    }
    // 若 signal 在 spawn 与注册之间被 abort，addEventListener 不会再回调，
    // 这里主动补一发。
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

    const buildResult = (extra?: Partial<HeadlessRunResult>): HeadlessRunResult => ({
      exitCode: null,
      stdout: decodePowerShellCliXml(stdout),
      stderr: decodePowerShellCliXml(stderr),
      timedOut,
      truncated,
      awaitingInput,
      cancelled,
      ...extra
    })

    const finish = (result: HeadlessRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (idleTimer) clearTimeout(idleTimer)
      if (killGraceTimer) clearTimeout(killGraceTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      activeChildren.delete(child)
      resolve(result)
    }

    // kill 之后的兜底收尾：killProcessTree 在 Windows 上是异步 taskkill、无回执，
    // 子进程若没被杀掉，close 事件就不会到来，工具调用会一直挂到 timeoutMs。
    function scheduleForceFinish(): void {
      if (killGraceTimer) return
      killGraceTimer = setTimeout(() => {
        finish(buildResult({ killedBySignal: 'SIGKILL' }))
      }, KILL_GRACE_MS)
    }

    child.on('error', (err) => {
      finish(
        buildResult({
          stderr: decodePowerShellCliXml(
            stderr + (stderr ? '\n' : '') + (err instanceof Error ? err.message : String(err))
          )
        })
      )
    })

    child.on('close', (code, signal) => {
      finish(buildResult({ exitCode: code, killedBySignal: signal ?? undefined }))
    })
  })
}
