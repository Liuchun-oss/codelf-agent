// 知识库专用 embedding worker（独立 utilityProcess）。
// 与代码语义检索的 embedWorker 完全隔离：这里加载中文模型 bge-small-zh-v1.5，
// 代码索引那套继续用 all-MiniLM-L6-v2，互不影响。
// 通过 parentPort 通信：收到 {id, texts} 返回 {id, vectors} 或 {id, error}。
import { join } from 'path'
import { existsSync } from 'fs'

// 中文检索模型。transformers.js 可加载其 ONNX 量化版（onnx/model_quantized.onnx）。
const MODEL_ID = 'Xenova/bge-small-zh-v1.5'

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
    // 内置模型不存在则允许联网下载到 userData 缓存（首次使用时）。
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

const EMBED_BATCH = 16

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
