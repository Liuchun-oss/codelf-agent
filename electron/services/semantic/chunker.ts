import { extOf } from '../fsService'

export interface CodeChunk {
  startLine: number
  endLine: number
  text: string
}

const MAX_CHUNK_LINES = 80
const MIN_TAIL_LINES = 4
const MAX_CHUNK_CHARS = 4000

// 识别“定义起始行”的启发式正则，覆盖主流语言的函数/类/方法声明。
const DEF_PATTERNS: RegExp[] = [
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+/,
  /^\s*(export\s+)?(abstract\s+)?(default\s+)?class\s+/,
  /^\s*(export\s+)?(public|private|protected|static|async|\s)*[\w<>,\[\]]+\s+\w+\s*\([^;]*\)\s*\{?\s*$/,
  /^\s*(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(?[^=]*\)?\s*=>/,
  /^\s*def\s+\w+\s*\(/,
  /^\s*(public|private|protected|internal)\s/,
  /^\s*func\s+/,
  /^\s*(pub\s+)?(async\s+)?fn\s+\w+/,
  /^\s*type\s+\w+\s+struct\s*\{/,
  /^\s*interface\s+\w+/
]

const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'go', 'rs', 'c', 'h',
  'cpp', 'cc', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt', 'kts', 'scala', 'm',
  'vue', 'svelte'
])

export function isChunkableCode(relPath: string): boolean {
  return CODE_EXT.has(extOf(relPath))
}

function isDefLine(line: string): boolean {
  return DEF_PATTERNS.some((re) => re.test(line))
}

// 在 [start, end) 范围内按行切成不超过上限的小块。
function flushRange(lines: string[], start: number, end: number, out: CodeChunk[]): void {
  let i = start
  while (i < end) {
    let j = Math.min(i + MAX_CHUNK_LINES, end)
    // 避免尾部留下极小的碎块
    if (end - j > 0 && end - j < MIN_TAIL_LINES) j = end
    let text = lines.slice(i, j).join('\n')
    if (text.length > MAX_CHUNK_CHARS) text = text.slice(0, MAX_CHUNK_CHARS)
    if (text.trim().length > 0) out.push({ startLine: i + 1, endLine: j, text })
    i = j
  }
}

// 把文件切成以函数/类定义为边界的块；非代码文件按定长行切。
export function chunkFile(relPath: string, content: string): CodeChunk[] {
  const lines = content.split(/\r\n|\r|\n/)
  if (lines.length === 0) return []
  const out: CodeChunk[] = []

  if (!isChunkableCode(relPath)) {
    flushRange(lines, 0, lines.length, out)
    return out
  }

  // 找出所有定义起始行作为切分点。
  const boundaries: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (isDefLine(lines[i])) boundaries.push(i)
  }

  if (boundaries.length === 0) {
    flushRange(lines, 0, lines.length, out)
    return out
  }

  // 文件开头到第一个定义之间的内容（import、常量等）单独成块。
  if (boundaries[0] > 0) flushRange(lines, 0, boundaries[0], out)

  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b]
    const end = b + 1 < boundaries.length ? boundaries[b + 1] : lines.length
    flushRange(lines, start, end, out)
  }
  return out
}
