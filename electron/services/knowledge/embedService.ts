import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { cpus } from 'os'

// 知识库中文模型。维度 512（bge-small-zh-v1.5）。
export const KB_EMBED_MODEL_ID = 'Xenova/bge-small-zh-v1.5'
export const KB_EMBED_DIM = 512

// 内置模型目录：打包后在 resourcesPath/models，开发时在项目 resources/models。
function bundledModelRoot(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'models')]
    : [join(app.getAppPath(), 'resources', 'models'), join(process.cwd(), 'resources', 'models')]
  return candidates.find((dir) => existsSync(join(dir, KB_EMBED_MODEL_ID, 'config.json'))) ?? null
}

function workerPath(): string {
  // 与主进程同目录产出（electron-vite 多入口，见 electron.vite.config.ts）。
  return join(__dirname, 'knowledgeEmbedWorker.js')
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
    serviceName: 'codelf-kb-embed',
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
    for (const p of pending.values()) p.reject(new Error('知识库 embedding 进程已退出'))
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

export function shutdownKnowledgeEmbedWorker(): void {
  if (child) {
    try {
      child.kill()
    } catch {
      // ignore
    }
    child = null
  }
}

// TODO（三期）：添加模型下载进度反馈。
// 如果内置模型不存在，transformers.js 首次使用时会自动下载到 userData/models，
// 但用户看不到进度，可能以为卡死。建议在 UI 层添加"模型下载中"提示。

// 通过独立进程计算一批向量，不阻塞主进程事件循环。
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
