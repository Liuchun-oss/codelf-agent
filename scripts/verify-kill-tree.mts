/**
 * issue #9 回归验证：killProcessTree 是否真的能回收整棵进程树。
 *
 * 断言（issue #9「修复应当包含的验证」一节要求的那几条）：
 *   1. 子进程（shell）死
 *   2. 孙进程（shell 里再起的 sleep）死
 *   3. 发起 kill 的这个进程仍然存活 —— 若负 pid 命中了别的进程组（例如本进程所在组），
 *      这里会直接消失，表现为脚本无输出中断
 *
 * 覆盖两条真实路径：
 *   A. run_terminal_cmd / PowerShell 走的 runCommand（前台 headless）
 *   B. StartTerminalTask 走的 backgroundTerminalTasks（issue #9 的实际肇事路径）
 *
 * inlineRun.ts 未覆盖：它 import 了 electron，无法在纯 node 下加载。
 *
 * 运行：npm run verify:kill-tree
 * 仅 POSIX 有意义：Windows 走 taskkill /T，issue 已确认不复现。
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const POSIX = process.platform !== 'win32'

const { runCommand, DETACHED_GROUP } = await import('../electron/services/headlessTerminal.ts')
const { startBackgroundTerminalTask, stopBackgroundTerminalTask, getBackgroundTerminalTask } = await import(
  '../electron/services/backgroundTerminalTasks.ts'
)

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// shell → sh → sleep 三层，只有组杀才收得全
const TREE_CMD = "sh -c 'sleep 300 & echo GRANDCHILD:$!; wait'"

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail: string): void {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
  if (!ok) failed++
}

function parseGrandchild(text: string): number | null {
  const m = text.match(/GRANDCHILD:(\d+)/)
  return m ? Number(m[1]) : null
}

async function waitForGrandchild(read: () => string, timeoutMs = 5000): Promise<number> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const pid = parseGrandchild(read())
    if (pid) {
      // 孙进程刚 spawn，给它一点时间真正跑起来
      await new Promise((r) => setTimeout(r, 300))
      return pid
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('未能从输出中取到孙进程 pid（命令没跑起来，或 shellInvocation 选的 shell 不存在）')
}

if (!POSIX) {
  console.log('SKIP  verify-kill-tree: Windows 走 taskkill /T，issue #9 在 Windows 不复现。')
  console.log('      在 Linux / macOS 上运行同一条命令才会真正执行断言。')
  process.exit(0)
}

check('前置：POSIX 下 spawn 应带 detached（子进程即组长）', DETACHED_GROUP === true, `DETACHED_GROUP=${DETACHED_GROUP}`)

async function caseA(): Promise<void> {
  let buf = ''
  const ac = new AbortController()
  const pending = runCommand(TREE_CMD, {
    cwd: ROOT,
    timeoutMs: 60_000,
    signal: ac.signal,
    onData: (chunk) => {
      buf += chunk
    }
  })

  const grandchild = await waitForGrandchild(() => buf)
  check('A 前置：kill 之前孙进程存活', isAlive(grandchild), `grandchild=${grandchild}`)

  ac.abort()
  const res = await pending
  await new Promise((r) => setTimeout(r, 500))

  check('A 孙进程已死', !isAlive(grandchild), `grandchild=${grandchild}`)
  check('A 本次调用按取消收尾', res.cancelled === true, `cancelled=${res.cancelled} killedBySignal=${res.killedBySignal}`)
}

async function caseB(): Promise<void> {
  const task = startBackgroundTerminalTask({ cwd: ROOT, command: TREE_CMD })
  const grandchild = await waitForGrandchild(() => getBackgroundTerminalTask(task.id)?.stdout ?? '')
  check('B 前置：kill 之前孙进程存活', isAlive(grandchild), `grandchild=${grandchild}`)

  stopBackgroundTerminalTask(task.id)
  await new Promise((r) => setTimeout(r, 500))

  const status = getBackgroundTerminalTask(task.id)?.status
  check('B 孙进程已死', !isAlive(grandchild), `grandchild=${grandchild}`)
  check('B 任务状态记为 stopped', status === 'stopped', `status=${status}`)
}

// 单独 try/catch：某条路径起不来时应该记 FAIL 并继续，而不是整个脚本崩掉
for (const [name, fn] of [
  ['A runCommand', caseA],
  ['B backgroundTerminalTask', caseB]
] as const) {
  try {
    await fn()
  } catch (err) {
    check(`${name} 执行`, false, err instanceof Error ? err.message : String(err))
  }
}

// 走到这里说明本进程没有被误杀
check('发起 kill 的主进程存活', isAlive(process.pid), `pid=${process.pid}`)

console.log(results.join('\n'))
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
