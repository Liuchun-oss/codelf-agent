/**
 * Pure helpers that turn a file path + language into a "run plan", decoupled
 * from the editor's active tab. Reused by both the editor Run button
 * (runFile.ts) and the chat-stream artifact runner (runStore).
 */
import { BROWSER_LANGUAGES, RUNNERS } from './runners'

export type RunKind = 'browser' | 'python' | 'command' | 'unsupported'

export interface RunPlan {
  kind: RunKind
  /** Human label of the toolchain, e.g. "Node.js" / "Python" / "浏览器". */
  label: string
  /** Shell command to execute (absent for browser / unsupported). */
  command?: string
}

function isWin(): boolean {
  return window.lc.getPlatform() === 'win32'
}

export function quoteArg(p: string): string {
  if (isWin()) return `'${p.replace(/'/g, "''")}'`
  return `'${p.replace(/'/g, "'\\''")}'`
}

function dirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx >= 0 ? p.slice(0, idx) : p
}

export function dirOfPath(p: string): string {
  return dirOf(p)
}

function baseNameNoExt(p: string): string {
  const name = p.split(/[\\/]/).pop() ?? p
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function isPython(language: string | undefined, path: string): boolean {
  return language === 'python' || /\.pyw?$/i.test(path)
}

/**
 * Resolve how a file should run. `pythonExe` (the user-selected interpreter)
 * is required to produce a runnable Python command; without it the plan is
 * still `kind: 'python'` but `command` is omitted so callers can prompt.
 */
export function resolveRunPlan(
  path: string,
  language: string | undefined,
  pythonExe?: string | null
): RunPlan {
  if (isPython(language, path)) {
    if (!pythonExe) return { kind: 'python', label: 'Python' }
    const cmd = isWin()
      ? `& ${quoteArg(pythonExe)} ${quoteArg(path)}`
      : `${quoteArg(pythonExe)} ${quoteArg(path)}`
    return { kind: 'python', label: 'Python', command: cmd }
  }

  if (language && BROWSER_LANGUAGES.has(language)) {
    return { kind: 'browser', label: '浏览器' }
  }

  const spec = language ? RUNNERS[language] : undefined
  if (!spec) return { kind: 'unsupported', label: '不支持' }

  const qp = quoteArg(path)
  const qd = quoteArg(dirOf(path))
  const base = baseNameNoExt(path)
  const command = isWin() && spec.win ? spec.win(qp, qd, base) : spec.build(qp, qd, base)
  return { kind: 'command', label: spec.label, command }
}
