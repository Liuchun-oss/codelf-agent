import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { platform, release, arch, type as osType } from 'os'
import { join, delimiter } from 'path'
import type {
  EnvCheckResult,
  EnvToolId,
  EnvToolResult
} from '@shared/envCheckTypes'

const IS_WIN = platform() === 'win32'

interface InstallInfo {
  url: string
  win: string
  mac: string
  linux: string
}

interface ToolSpec {
  id: EnvToolId
  name: string
  hint: string
  /** 可执行文件名（不含扩展名），按顺序探测 */
  commands: string[]
  /** 获取版本的参数 */
  versionArgs: string[]
  /** 安装引导信息 */
  install: InstallInfo
}

const TOOL_SPECS: ToolSpec[] = [
  {
    id: 'git',
    name: 'Git',
    hint: '版本控制与源代码管理，源代码面板、提交、分支等功能依赖它。',
    commands: ['git'],
    versionArgs: ['--version'],
    install: {
      url: 'https://git-scm.com/downloads',
      win: 'winget install --id Git.Git -e',
      mac: 'brew install git',
      linux: 'sudo apt install git'
    }
  },
  {
    id: 'node',
    name: 'Node.js',
    hint: 'JavaScript 运行时，运行前端工具链与脚本的基础（自带 npm）。',
    commands: ['node'],
    versionArgs: ['--version'],
    install: {
      url: 'https://nodejs.org/zh-cn/download',
      win: 'winget install --id OpenJS.NodeJS.LTS -e',
      mac: 'brew install node',
      linux: 'sudo apt install nodejs'
    }
  },
  {
    id: 'python',
    name: 'Python',
    hint: '运行 Python 脚本，并为 .py 文件提供类型分析与智能提示。',
    commands: IS_WIN ? ['python', 'python3'] : ['python3', 'python'],
    versionArgs: ['--version'],
    install: {
      url: 'https://www.python.org/downloads/',
      win: 'winget install --id Python.Python.3.12 -e',
      mac: 'brew install python',
      linux: 'sudo apt install python3'
    }
  }
]

function isBatch(file: string): boolean {
  return /\.(cmd|bat)$/i.test(file)
}

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs = 5000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Windows: 直接 execFile 运行 .cmd/.bat 会抛 spawn EINVAL（Node CVE-2024-27980 修复），
    // 必须走 shell 模式。命令路径与参数均为内置常量，无注入风险，仅做双引号包裹。
    const useShell = IS_WIN && isBatch(file)
    const cmd = useShell ? `"${file}"` : file
    const cmdArgs = useShell ? args.map((a) => `"${a}"`) : args
    execFile(
      cmd,
      cmdArgs,
      { timeout: timeoutMs, windowsHide: true, shell: useShell },
      (err, stdout, stderr) => {
        if (err && !stdout) resolve({ ok: false, stdout: '', stderr: String(err.message || stderr) })
        else resolve({ ok: true, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

/** 在 PATH 中解析命令的可执行文件绝对路径。 */
function resolveOnPath(command: string): string | undefined {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : ['']
  const dirs = (process.env.PATH || '').split(delimiter)
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const full = join(dir, command + ext)
      if (existsSync(full)) return full
    }
  }
  return undefined
}

function parseVersion(text: string): string | undefined {
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(text)
  return m ? m[1] : undefined
}

async function checkTool(spec: ToolSpec): Promise<EnvToolResult> {
  const installCmd =
    platform() === 'win32'
      ? spec.install.win
      : platform() === 'darwin'
        ? spec.install.mac
        : spec.install.linux
  const base = {
    id: spec.id,
    name: spec.name,
    hint: spec.hint,
    installUrl: spec.install.url,
    installCmd
  }
  for (const cmd of spec.commands) {
    const resolved = resolveOnPath(cmd)
    const exe = resolved ?? cmd
    const { ok, stdout, stderr } = await execFileAsync(exe, spec.versionArgs)
    const out = `${stdout} ${stderr}`.trim()
    if (ok && out) {
      const version = parseVersion(out)
      return {
        ...base,
        status: 'installed',
        version,
        path: resolved
      }
    }
  }
  return {
    ...base,
    status: 'missing'
  }
}

function describeOs(): string {
  const t = osType()
  const r = release()
  if (platform() === 'win32') return `Windows (${r})`
  if (platform() === 'darwin') return `macOS (${r})`
  return `${t} ${r}`
}

/** 检测当前系统是否安装了开发所需的关键环境。 */
export async function checkEnvironment(): Promise<EnvCheckResult> {
  const tools = await Promise.all(TOOL_SPECS.map((spec) => checkTool(spec)))
  return {
    platform: platform(),
    osVersion: describeOs(),
    arch: arch(),
    checkedAt: Date.now(),
    tools
  }
}
