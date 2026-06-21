import { app } from 'electron'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { TokenizerLoader } from '@lenml/tokenizers'


type LoadedTokenizer = {
  encode(text: string): number[]
  decode(tokenIds: number[], args?: { skip_special_tokens?: boolean }): string
}

let cached: LoadedTokenizer | null = null
let attempted = false


function resolveTokenizerDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'deepseek-tokenizer')
  }
  return join(__dirname, '../../resources/deepseek-tokenizer')
}


function loadTokenizer(): LoadedTokenizer | null {
  if (attempted) return cached
  attempted = true
  try {
    const dir = resolveTokenizerDir()
    const jsonPath = join(dir, 'tokenizer.json')
    const configPath = join(dir, 'tokenizer_config.json')
    if (!existsSync(jsonPath) || !existsSync(configPath)) {
      console.error('[deepseekTokenizer] 分词器文件缺失，回退近似计数')
      return null
    }
    const tokenizerJSON = JSON.parse(readFileSync(jsonPath, 'utf-8'))
    const tokenizerConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
    cached = TokenizerLoader.fromPreTrained({ tokenizerJSON, tokenizerConfig }) as LoadedTokenizer
  } catch (e) {
    console.error('[deepseekTokenizer] 加载失败，回退近似计数', e)
    cached = null
  }
  return cached
}



export function countDeepSeekTokens(text: string): number | null {
  if (!text) return 0
  const tk = loadTokenizer()
  if (!tk) return null
  try {
    return tk.encode(text).length
  } catch {
    return null
  }
}


// 用 DeepSeek 分词器把文本精确裁剪到 maxTokens 以内。
// 返回 null 表示分词器不可用，调用方需自行回退。
export function truncateDeepSeekTokens(
  text: string,
  maxTokens: number
): { text: string; truncated: boolean } | null {
  if (!text) return { text: '', truncated: false }
  if (maxTokens <= 0) return { text: '', truncated: true }
  const tk = loadTokenizer()
  if (!tk) return null
  try {
    const tokens = tk.encode(text)
    if (tokens.length <= maxTokens) return { text, truncated: false }
    const decoded = tk.decode(tokens.slice(0, maxTokens), { skip_special_tokens: true })
    return { text: decoded, truncated: true }
  } catch {
    return null
  }
}


export function isDeepSeekModel(model?: string, kind?: string): boolean {
  if (kind === 'deepseek') return true
  return !!model && model.toLowerCase().includes('deepseek')
}
