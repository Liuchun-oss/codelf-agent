import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { cpus } from 'os'

export const EMBED_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
export const EMBED_DIM = 384

// 内置模型目录：打包后在 resourcesPath/models，开发时在项目 resources/models。
function bundledModelRoot(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'models')]
    : [join(app.getAppPath(), 'resources', 'models'), join(process.cwd(), 'resources', 'models')]
  return candidates.find((dir) => existsSync(join(dir, EMBED_MODEL_ID, 'config.json'))) ?? null
}

function workerPath(): string {
  // worker 与主进程同目录产出（electron-vite 多入口）。
  return join(__dirname, 'embedWorker.js')
}

interface Pending {
  resolve: (v: number[][]) => void
  reject: (e: Error) => void
}

let child: UtilityProcess | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function spawnWorker(): UtilityProcess {
  const cores = cpus().length || 4
  const threads = Math.max(1, Math.min(4, Math.floor(cores / 2)))

  const proc = utilityProcess.fork(workerPath(), [], {
    serviceName: 'codelf-embed',
    // 限制底层线程，避免吃满 CPU 卡死整机。
    env: { ...process.env, OMP_NUM_THREADS: String(threads) }
  })

  proc.on('message', (msg: { id: number; vectors?: number[][]; error?: string }) => {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error))
    else p.resolve(msg.vectors ?? [])
  })

  proc.on('exit', () => {
    // 进程退出：所有挂起请求失败，下次调用会重新拉起。
    for (const p of pending.values()) p.reject(new Error('embedding 进程已退出'))
    pending.clear()
    if (child === proc) child = null
  })

  proc.postMessage({
    type: 'init',
    config: {
      bundledModelRoot: bundledModelRoot(),
      userDataModelDir: join(app.getPath('userData'), 'models'),
      threads
    }
  })
  return proc
}

function ensureWorker(): UtilityProcess {
  if (!child) child = spawnWorker()
  return child
}

// 关闭 worker（应用退出时调用）。
export function shutdownEmbedWorker(): void {
  if (child) {
    try {
      child.kill()
    } catch {
      // ignore
    }
    child = null
  }
}

// 通过独立进程计算一批向量；主进程事件循环不被阻塞。
export function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return Promise.resolve([])
  const proc = ensureWorker()
  const id = nextId++
  return new Promise<number[][]>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    proc.postMessage({ type: 'embed', id, texts })
  })
}

export async function embedOne(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text])
  return vec
}
