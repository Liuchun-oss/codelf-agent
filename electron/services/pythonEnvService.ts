import { execFile } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { homedir, platform } from 'os'
import { join, basename, dirname } from 'path'
import type { PythonEnv, PythonEnvKind } from '@shared/pythonTypes'

const IS_WIN = platform() === 'win32'

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs = 5000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout) resolve({ stdout: '', stderr: String(err.message || stderr) })
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** Query an interpreter for its version. Returns e.g. "3.12.1" or undefined. */
export async function probeVersion(executable: string): Promise<string | undefined> {
  if (!existsSync(executable)) return undefined
  const { stdout, stderr } = await execFileAsync(executable, [
    '-c',
    'import sys;print("%d.%d.%d"%sys.version_info[:3])'
  ])
  const out = (stdout || stderr).trim()
  const m = /(\d+\.\d+\.\d+)/.exec(out)
  return m ? m[1] : undefined
}

function pushUnique(map: Map<string, { exe: string; kind: PythonEnvKind }>, exe: string, kind: PythonEnvKind): void {
  if (!exe) return
  const norm = IS_WIN ? exe.toLowerCase() : exe
  if (map.has(norm)) return
  if (!existsSync(exe)) return
  map.set(norm, { exe, kind })
}

/** Candidate interpreters from PATH-like environment + the launcher. */
async function fromPath(map: Map<string, { exe: string; kind: PythonEnvKind }>): Promise<void> {
  const names = IS_WIN ? ['python.exe', 'python3.exe'] : ['python3', 'python']
  const pathDirs = (process.env.PATH || '').split(IS_WIN ? ';' : ':')
  for (const dir of pathDirs) {
    if (!dir) continue
    for (const n of names) {
      const full = join(dir, n)
      if (existsSync(full)) pushUnique(map, full, 'global')
    }
  }
}

/** Common per-user / system install directories. */
async function fromCommonDirs(map: Map<string, { exe: string; kind: PythonEnvKind }>): Promise<void> {
  const home = homedir()
  const candidates: string[] = []
  if (IS_WIN) {
    const localPrograms = join(home, 'AppData', 'Local', 'Programs', 'Python')
    candidates.push(localPrograms)
    candidates.push('C:\\Python39', 'C:\\Python310', 'C:\\Python311', 'C:\\Python312', 'C:\\Python313')
    for (const base of [localPrograms]) {
      try {
        const entries = await fs.readdir(base, { withFileTypes: true })
        for (const e of entries) {
          if (e.isDirectory() && /^Python\d/i.test(e.name)) {
            pushUnique(map, join(base, e.name, 'python.exe'), 'global')
          }
        }
      } catch {
        
      }
    }
    for (const c of candidates) pushUnique(map, join(c, 'python.exe'), 'global')
  } else {
    candidates.push('/usr/bin', '/usr/local/bin', '/opt/homebrew/bin')
    for (const c of candidates) {
      pushUnique(map, join(c, 'python3'), 'global')
      pushUnique(map, join(c, 'python'), 'global')
    }
  }
}

/** Conda environments listed in ~/.conda/environments.txt and the base install. */
async function fromConda(map: Map<string, { exe: string; kind: PythonEnvKind }>): Promise<void> {
  const home = homedir()
  const envsTxt = join(home, '.conda', 'environments.txt')
  const roots: string[] = []
  try {
    const txt = await fs.readFile(envsTxt, 'utf8')
    for (const line of txt.split(/\r?\n/)) {
      const p = line.trim()
      if (p) roots.push(p)
    }
  } catch {
    
  }
  for (const root of roots) {
    const exe = IS_WIN ? join(root, 'python.exe') : join(root, 'bin', 'python')
    pushUnique(map, exe, 'conda')
  }
}

/** Virtual environments inside the workspace (venv/.venv/env). */
async function fromWorkspaceVenvs(map: Map<string, { exe: string; kind: PythonEnvKind }>, workspaceRoot?: string): Promise<void> {
  if (!workspaceRoot) return
  const names = ['.venv', 'venv', 'env', '.env']
  for (const n of names) {
    const root = join(workspaceRoot, n)
    const exe = IS_WIN ? join(root, 'Scripts', 'python.exe') : join(root, 'bin', 'python')
    pushUnique(map, exe, 'venv')
  }
}

/** Build a friendly label/detail for an interpreter. */
function describe(exe: string, version: string | undefined, kind: PythonEnvKind): PythonEnv {
  const dir = dirname(exe)
  let envName = ''
  if (kind === 'conda' || kind === 'venv') {
    
    const root = basename(exe).toLowerCase().startsWith('python') && /scripts|bin$/i.test(basename(dir))
      ? dirname(dir)
      : dir
    envName = basename(root)
  }
  const verStr = version ? version : '未知版本'
  let label: string
  if (kind === 'conda') label = `${envName} (${verStr})`
  else if (kind === 'venv') label = `${envName} (${verStr}) · venv`
  else label = `Python ${verStr}`

  const kindTag =
    kind === 'conda' ? 'Conda' : kind === 'venv' ? 'venv' : kind === 'global' ? '全局' : ''

  return {
    id: IS_WIN ? exe.toLowerCase() : exe,
    executable: exe,
    version,
    kind,
    label,
    detail: kindTag ? `${exe}  ·  ${kindTag}` : exe
  }
}

/** Discover all Python interpreters on the machine + workspace. */
export async function discoverPythonEnvs(workspaceRoot?: string): Promise<PythonEnv[]> {
  const map = new Map<string, { exe: string; kind: PythonEnvKind }>()
  await fromWorkspaceVenvs(map, workspaceRoot)
  await fromPath(map)
  await fromCommonDirs(map)
  await fromConda(map)

  const entries = [...map.values()]
  const envs = await Promise.all(
    entries.map(async ({ exe, kind }) => {
      const version = await probeVersion(exe)
      return describe(exe, version, kind)
    })
  )

  
  const valid = envs.filter((e) => e.version)
  
  valid.sort((a, b) => {
    const order: Record<PythonEnvKind, number> = { venv: 0, global: 1, conda: 2, pyenv: 3, unknown: 4 }
    const d = order[a.kind] - order[b.kind]
    if (d !== 0) return d
    return (b.version ?? '').localeCompare(a.version ?? '', undefined, { numeric: true })
  })
  
  if (valid.length > 0) valid[0] = { ...valid[0], recommended: true }
  return valid
}
