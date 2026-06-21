// 独立 utilityProcess：专门跑 embedding 推理，避免阻塞主进程事件循环与 UI。
// 通过 parentPort 与主进程通信：收到 {id, texts} 返回 {id, vectors} 或 {id, error}。
import { join } from 'path'
import { existsSync } from 'fs'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

type FeatureExtractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<{ tolist(): number[][] }>

let extractorPromise: Promise<FeatureExtractor> | null = null

interface InitConfig {
  bundledModelRoot: string | null
  userDataModelDir: string
  threads: number
}

let config: InitConfig | null = null

async function loadExtractor(): Promise<FeatureExtractor> {
  if (config && config.threads > 0 && !process.env.OMP_NUM_THREADS) {
    process.env.OMP_NUM_THREADS = String(config.threads)
  }
  const mod = await import('@huggingface/transformers')
  const { env, pipeline } = mod

  const bundled = config?.bundledModelRoot
  if (bundled && existsSync(join(bundled, MODEL_ID, 'config.json'))) {
    env.allowLocalModels = true
    env.allowRemoteModels = false
    env.localModelPath = bundled
  } else {
    env.allowLocalModels = false
    env.allowRemoteModels = true
    if (config?.userDataModelDir) env.cacheDir = config.userDataModelDir
  }

  const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })
  return extractor as unknown as FeatureExtractor
}

function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = loadExtractor().catch((e) => {
      extractorPromise = null
      throw e
    })
  }
  return extractorPromise
}

const EMBED_BATCH = 32

async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const extractor = await getExtractor()
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH)
    const res = await extractor(batch, { pooling: 'mean', normalize: true })
    for (const vec of res.tolist()) out.push(vec)
  }
  return out
}

interface RequestMsg {
  type: 'init' | 'embed'
  id?: number
  config?: InitConfig
  texts?: string[]
}

const port = process.parentPort
if (port) {
  port.on('message', (e: { data: RequestMsg }) => {
    const msg = e.data
    if (msg.type === 'init') {
      config = msg.config ?? null
      // 预热模型加载，结果忽略，错误留给后续 embed 上报。
      void getExtractor().catch(() => {})
      return
    }
    if (msg.type === 'embed' && typeof msg.id === 'number') {
      const id = msg.id
      embed(msg.texts ?? [])
        .then((vectors) => port.postMessage({ id, vectors }))
        .catch((err) =>
          port.postMessage({ id, error: err instanceof Error ? err.message : '推理失败' })
        )
    }
  })
}
