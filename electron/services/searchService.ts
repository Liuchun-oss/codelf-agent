import { promises as fs } from 'fs'
import { join } from 'path'
import type { Ignore } from 'ignore'
import { IGNORED_DIRS, buildIgnore, toRel, detectEncoding, decodeText } from './fsService'



// 单文件搜索上限：从 5MB 提到 32MB。超过此值仍会跳过（避免一次性读入超大日志/数据文件
// 拖垮内存），但会通过 skippedLargeFiles 明确告知模型，不再静默"假装无匹配"。
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_MATCHES = 5000
const MAX_MATCHES_PER_FILE = 300
// 超长行截断上限：压缩/minified 文件常有几十万字符的单行，正则在其上回溯可能卡死。
// 超过此长度的行按固定窗口切片后逐段匹配，兼顾命中率与性能。
const MAX_LINE_SCAN_CHARS = 20_000
// 全局搜索时间上限：防止灾难性回溯的正则（如 (a+)+）在大代码库上无限期占用主进程。
const SEARCH_DEADLINE_MS = 15_000

// 智能解码：统一走 detectEncoding + decodeText（已支持 BOM / UTF-16 / GBK），
// 与读文件、编辑落盘共用同一套编码判定，避免两处逻辑漂移导致搜索与编辑对同一文件
// 判定不一致。
function decodeSmart(buf: Buffer): string {
  const { encoding } = detectEncoding(buf)
  return decodeText(buf, encoding)
}

export interface SearchOptions {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
}

export interface SearchMatch {
  line: number
  col: number
  preview: string
  matchLength: number
}

export interface SearchFileResult {
  path: string
  matches: SearchMatch[]
}

export interface SearchResponse {
  ok: boolean
  results: SearchFileResult[]
  truncated: boolean
  error?: string
  // 因超过 MAX_FILE_BYTES 被跳过的文件数（相对路径），供上层明确提示模型而非静默丢结果。
  skippedLargeFiles?: string[]
  // 是否因达到全局时间上限提前结束（结果可能不完整）。
  timedOut?: boolean
}

export function buildRegex(query: string, opts: SearchOptions): RegExp {
  let pattern = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (opts.wholeWord) pattern = `\\b${pattern}\\b`
  const flags = 'g' + (opts.caseSensitive ? '' : 'i')
  return new RegExp(pattern, flags)
}

function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000))
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) return true
  return false
}

interface Ctx {
  root: string
  re: RegExp
  ig: Ignore | null
  results: SearchFileResult[]
  total: number
  truncated: boolean
  deadline: number
  timedOut: boolean
  skippedLargeFiles: string[]
}

function stopScanning(ctx: Ctx): boolean {
  if (ctx.truncated) return true
  if (Date.now() >= ctx.deadline) {
    ctx.timedOut = true
    return true
  }
  return false
}

async function walk(ctx: Ctx, dir: string, depth = 0): Promise<void> {
  if (depth > 40 || stopScanning(ctx)) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (stopScanning(ctx)) return
    if (IGNORED_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    const isDir = entry.isDirectory()
    if (ctx.ig) {
      const rel = toRel(ctx.root, fullPath) + (isDir ? '/' : '')
      if (rel && ctx.ig.ignores(rel)) continue
    }
    if (isDir) {
      await walk(ctx, fullPath, depth + 1)
    } else if (entry.isFile()) {
      await searchInFile(ctx, fullPath)
    }
  }
}

// 在单行上执行正则匹配。超长行按固定窗口切片逐段扫描（窗口间保留重叠，
// 避免跨边界的匹配被漏掉），把每段匹配的列号换算回原始行内绝对列号。
function collectLineMatches(
  ctx: Ctx,
  line: number,
  text: string,
  matches: SearchMatch[]
): boolean {
  const runOnSegment = (segment: string, baseCol: number): boolean => {
    ctx.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ctx.re.exec(segment)) !== null) {
      const absCol = baseCol + m.index
      matches.push({
        line,
        col: absCol + 1,
        preview: text.length > 400 ? text.slice(0, 400) : text,
        matchLength: m[0].length
      })
      ctx.total++
      if (m[0].length === 0) ctx.re.lastIndex++
      if (matches.length >= MAX_MATCHES_PER_FILE || ctx.total >= MAX_TOTAL_MATCHES) {
        ctx.truncated = true
        return true
      }
    }
    return false
  }

  if (text.length <= MAX_LINE_SCAN_CHARS) {
    return runOnSegment(text, 0)
  }
  // 超长行：切片扫描，段间重叠 1KB 以覆盖跨边界匹配。
  const overlap = 1024
  for (let start = 0; start < text.length; start += MAX_LINE_SCAN_CHARS - overlap) {
    const segment = text.slice(start, start + MAX_LINE_SCAN_CHARS)
    if (runOnSegment(segment, start)) return true
    if (Date.now() >= ctx.deadline) {
      ctx.timedOut = true
      return true
    }
  }
  return false
}

async function searchInFile(ctx: Ctx, path: string): Promise<void> {
  let buf: Buffer
  try {
    const stat = await fs.stat(path)
    if (stat.size === 0) return
    if (stat.size > MAX_FILE_BYTES) {
      // 超大文件不再静默跳过：记录相对路径，供上层明确告知模型（而非"无匹配"）。
      ctx.skippedLargeFiles.push(toRel(ctx.root, path))
      return
    }
    buf = await fs.readFile(path)
  } catch {
    return
  }
  if (isBinary(buf)) return

  const text = decodeSmart(buf)
  const lines = text.split(/\r\n|\r|\n/)
  const matches: SearchMatch[] = []

  for (let i = 0; i < lines.length; i++) {
    if (collectLineMatches(ctx, i + 1, lines[i], matches)) break
    if (ctx.truncated) break
    // 每扫若干行检查一次 deadline，避免超大文件长时间独占。
    if ((i & 0x3ff) === 0 && Date.now() >= ctx.deadline) {
      ctx.timedOut = true
      break
    }
  }

  if (matches.length > 0) ctx.results.push({ path, matches })
}


export async function searchInFiles(
  root: string,
  query: string,
  opts: SearchOptions
): Promise<SearchResponse> {
  if (!root || !query) return { ok: true, results: [], truncated: false }
  let re: RegExp
  try {
    re = buildRegex(query, opts)
  } catch {
    return { ok: false, results: [], truncated: false, error: '无效的正则表达式' }
  }
  const ig = await buildIgnore(root)
  const ctx: Ctx = {
    root,
    re,
    ig,
    results: [],
    total: 0,
    truncated: false,
    deadline: Date.now() + SEARCH_DEADLINE_MS,
    timedOut: false,
    skippedLargeFiles: []
  }
  // path 可能指向单个文件（walk 会对其 readdir 失败并被静默吞掉，导致"无匹配"假象）。
  // 因此先判定类型：文件走 searchInFile，目录走 walk。
  try {
    const stat = await fs.stat(root)
    if (stat.isFile()) {
      await searchInFile(ctx, root)
    } else {
      await walk(ctx, root)
    }
  } catch {
    await walk(ctx, root)
  }
  return {
    ok: true,
    results: ctx.results,
    truncated: ctx.truncated,
    timedOut: ctx.timedOut,
    ...(ctx.skippedLargeFiles.length ? { skippedLargeFiles: ctx.skippedLargeFiles } : {})
  }
}


export async function replaceInFiles(
  paths: string[],
  query: string,
  replacement: string,
  opts: SearchOptions
): Promise<{ ok: boolean; changed: number; error?: string }> {
  let re: RegExp
  try {
    re = buildRegex(query, opts)
  } catch {
    return { ok: false, changed: 0, error: '无效的正则表达式' }
  }
  let changed = 0
  for (const path of paths) {
    try {
      const buf = await fs.readFile(path)
      if (isBinary(buf)) continue
      const text = buf.toString('utf8')
      re.lastIndex = 0
      const next = text.replace(re, replacement)
      if (next !== text) {
        await fs.writeFile(path, next, 'utf8')
        changed++
      }
    } catch {
      
    }
  }
  return { ok: true, changed }
}





export interface CodebaseHit {
  path: string
  score: number
  
  snippets: string[]
}

export interface CodebaseSearchResponse {
  ok: boolean
  hits: CodebaseHit[]
  truncated: boolean
  error?: string
}

const CODEBASE_MAX_FILES_SCANNED = 4000
const CODEBASE_MAX_HITS = 20
const CODEBASE_SNIPPETS_PER_FILE = 3


function tokenizeQuery(query: string): string[] {
  const seen = new Set<string>()
  for (const raw of query.split(/[^A-Za-z0-9_]+/)) {
    const t = raw.toLowerCase()
    if (t.length >= 2) seen.add(t)
  }
  return [...seen]
}

interface FileScore {
  path: string
  score: number
  snippets: { line: number; text: string }[]
}


function scoreFile(rel: string, text: string, tokens: string[]): FileScore | null {
  const lowerPath = rel.toLowerCase()
  let score = 0
  for (const t of tokens) {
    if (lowerPath.includes(t)) score += 5
  }

  const matchedTokens = new Set<string>()
  const lines = text.split(/\r\n|\r|\n/)
  const snippets: { line: number; text: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase()
    let lineHits = 0
    for (const t of tokens) {
      if (lower.includes(t)) {
        lineHits++
        matchedTokens.add(t)
      }
    }
    if (lineHits > 0) {
      
      score += lineHits * lineHits
      if (snippets.length < CODEBASE_SNIPPETS_PER_FILE) {
        const trimmed = lines[i].trim()
        snippets.push({ line: i + 1, text: trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed })
      }
    }
  }
  if (score === 0) return null
  
  if (tokens.length > 1) {
    const coverage = matchedTokens.size / tokens.length
    score = Math.round(score * (1 + coverage))
    
    if (matchedTokens.size === tokens.length) score += tokens.length * 10
  }
  return { path: rel, score, snippets }
}

interface CodebaseCtx {
  root: string
  tokens: string[]
  ig: Ignore | null
  scored: FileScore[]
  scanned: number
  truncated: boolean
}

async function walkCodebase(ctx: CodebaseCtx, dir: string, depth = 0): Promise<void> {
  if (depth > 40 || ctx.scanned >= CODEBASE_MAX_FILES_SCANNED) {
    ctx.truncated = true
    return
  }
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (ctx.scanned >= CODEBASE_MAX_FILES_SCANNED) {
      ctx.truncated = true
      return
    }
    if (IGNORED_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    const isDir = entry.isDirectory()
    if (ctx.ig) {
      const rel = toRel(ctx.root, fullPath) + (isDir ? '/' : '')
      if (rel && ctx.ig.ignores(rel)) continue
    }
    if (isDir) {
      await walkCodebase(ctx, fullPath, depth + 1)
    } else if (entry.isFile()) {
      await scoreCodebaseFile(ctx, fullPath)
    }
  }
}

async function scoreCodebaseFile(ctx: CodebaseCtx, path: string): Promise<void> {
  let buf: Buffer
  try {
    const stat = await fs.stat(path)
    if (stat.size > MAX_FILE_BYTES || stat.size === 0) return
    buf = await fs.readFile(path)
  } catch {
    return
  }
  if (isBinary(buf)) return
  ctx.scanned++
  const rel = toRel(ctx.root, path)
  const scored = scoreFile(rel, buf.toString('utf8'), ctx.tokens)
  if (scored) ctx.scored.push(scored)
}


export async function searchCodebase(root: string, query: string): Promise<CodebaseSearchResponse> {
  if (!root || !query.trim()) return { ok: true, hits: [], truncated: false }
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return { ok: true, hits: [], truncated: false }

  const ig = await buildIgnore(root)
  const ctx: CodebaseCtx = { root, tokens, ig, scored: [], scanned: 0, truncated: false }
  await walkCodebase(ctx, root)

  ctx.scored.sort((a, b) => b.score - a.score)
  const hits: CodebaseHit[] = ctx.scored.slice(0, CODEBASE_MAX_HITS).map((f) => ({
    path: f.path,
    score: f.score,
    snippets: f.snippets.map((s) => `${s.line}: ${s.text}`)
  }))
  return { ok: true, hits, truncated: ctx.truncated || ctx.scored.length > CODEBASE_MAX_HITS }
}
