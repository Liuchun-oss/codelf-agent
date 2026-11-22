const DEFAULT_MAX_LINES = 300
const DEFAULT_MAX_BYTES = 20 * 1024
const MAX_LINE_CHARS = 2000

export interface TailOptions {
  maxLines?: number
  maxBytes?: number
}

// 只按行数裁剪时，单行超长的输出（压缩过的 JSON、base64、乱码）会把整个结果
// 原样带到上下文里，因此这里同时限制单行长度与总字节数。
function capLine(line: string): string | null {
  if (line.length <= MAX_LINE_CHARS) return null
  return `${line.slice(0, MAX_LINE_CHARS)}…（单行过长已截断，原长 ${line.length} 字符）`
}

export function tailOutput(text: string, opts: TailOptions = {}): { text: string; truncated: boolean } {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES

  let truncated = false
  let lines = text.split('\n')
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines)
    truncated = true
  }

  const capped = lines.map((line) => {
    const next = capLine(line)
    if (next === null) return line
    truncated = true
    return next
  })

  let out = capped.join('\n')
  const bytes = Buffer.byteLength(out, 'utf8')
  if (bytes > maxBytes) {
    truncated = true
    out = Buffer.from(out, 'utf8')
      .subarray(bytes - maxBytes)
      .toString('utf8')
    // 按字节切片可能切开一行或一个多字节字符，丢掉首行残片。
    const newline = out.indexOf('\n')
    if (newline >= 0) out = out.slice(newline + 1)
  }

  return { text: out, truncated }
}
