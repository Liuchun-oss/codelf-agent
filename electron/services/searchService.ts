import { promises as fs } from 'fs'
import { join } from 'path'
import type { Ignore } from 'ignore'
import { IGNORED_DIRS, buildIgnore, toRel } from './fsService'



const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_MATCHES = 5000
const MAX_MATCHES_PER_FILE = 300

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
}

async function walk(ctx: Ctx, dir: string, depth = 0): Promise<void> {
  if (depth > 40 || ctx.truncated) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (ctx.truncated) return
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

async function searchInFile(ctx: Ctx, path: string): Promise<void> {
  let buf: Buffer
  try {
    const stat = await fs.stat(path)
    if (stat.size > MAX_FILE_BYTES || stat.size === 0) return
    buf = await fs.readFile(path)
  } catch {
    return
  }
  if (isBinary(buf)) return

  const text = buf.toString('utf8')
  const lines = text.split(/\r\n|\r|\n/)
  const matches: SearchMatch[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    ctx.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ctx.re.exec(line)) !== null) {
      matches.push({
        line: i + 1,
        col: m.index + 1,
        preview: line.length > 400 ? line.slice(0, 400) : line,
        matchLength: m[0].length
      })
      ctx.total++
      if (m[0].length === 0) ctx.re.lastIndex++ 
      if (matches.length >= MAX_MATCHES_PER_FILE || ctx.total >= MAX_TOTAL_MATCHES) {
        ctx.truncated = true
        break
      }
    }
    if (ctx.truncated) break
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
  const ctx: Ctx = { root, re, ig, results: [], total: 0, truncated: false }
  await walk(ctx, root)
  return { ok: true, results: ctx.results, truncated: ctx.truncated }
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
