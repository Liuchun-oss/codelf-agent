import { promises as fs } from 'fs'
import { join, basename, dirname } from 'path'
import { randomBytes } from 'crypto'
import ignore, { type Ignore } from 'ignore'
import iconv from 'iconv-lite'



// gbk：Windows 简体中文旧文件常用编码（GB2312 的超集，iconv 用 gb18030 无损读写）。
// 无 BOM，需靠 UTF-8 合法性校验失败来推断。落盘时必须沿用，否则整文件被写成 UTF-8 而损坏。
export type FileEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'gbk'

export interface ReadFileResult {
  ok: boolean
  kind?: 'text' | 'image' | 'binary'
  content?: string
  dataUrl?: string
  encoding?: FileEncoding
  size?: number
  tooLarge?: boolean
  error?: string
}


export const MAX_TEXT_BYTES = 16 * 1024 * 1024
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024


export const IGNORED_DIRS = new Set(['.git'])

const IMAGE_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

export function extOf(p: string): string {
  const name = basename(p).toLowerCase()
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1) : ''
}


// 校验 buffer 是否为合法 UTF-8 字节序列。用于区分「无 BOM 的 UTF-8」与「GBK 等旧编码」：
// GBK 里的双字节汉字通常构成非法 UTF-8 序列，据此把它们从「兜底当 UTF-8」中甄别出来。
function isValidUtf8(buf: Buffer): boolean {
  let i = 0
  const len = buf.length
  while (i < len) {
    const b = buf[i]
    if (b <= 0x7f) { i++; continue }
    let extra: number
    if (b >= 0xc2 && b <= 0xdf) extra = 1
    else if (b >= 0xe0 && b <= 0xef) extra = 2
    else if (b >= 0xf0 && b <= 0xf4) extra = 3
    else return false
    if (i + extra >= len) return false
    for (let j = 1; j <= extra; j++) {
      if ((buf[i + j] & 0xc0) !== 0x80) return false
    }
    i += extra + 1
  }
  return true
}

export function detectEncoding(buf: Buffer): { encoding: FileEncoding; binary: boolean } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf8bom', binary: false }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf16le', binary: false }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf16be', binary: false }
  }
  const sample = buf.subarray(0, Math.min(buf.length, 8000))
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return { encoding: 'utf8', binary: true }
  }
  // 无 BOM：合法 UTF-8 直接判 UTF-8；否则若含高位字节(可能是 GBK 汉字)则判 gbk，
  // 纯 ASCII（全 ≤0x7f）也是合法 UTF-8，走上面分支。sample 足够代表整体编码倾向。
  if (isValidUtf8(sample)) return { encoding: 'utf8', binary: false }
  return { encoding: 'gbk', binary: false }
}

export function decodeText(buf: Buffer, encoding: FileEncoding): string {
  switch (encoding) {
    case 'utf8bom':
      return buf.subarray(3).toString('utf8')
    case 'utf16le':
      return buf.subarray(2).toString('utf16le')
    case 'utf16be': {
      const body = Buffer.from(buf.subarray(2))
      body.swap16()
      return body.toString('utf16le')
    }
    case 'gbk':
      // gb18030 是 GBK/GB2312 的严格超集，用它解码可无损覆盖简体中文旧文件。
      return iconv.decode(buf, 'gb18030')
    default:
      return buf.toString('utf8')
  }
}

export function encodeText(text: string, encoding: FileEncoding): Buffer {
  switch (encoding) {
    case 'utf8bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'utf16be': {
      const body = Buffer.from(text, 'utf16le')
      body.swap16()
      return Buffer.concat([Buffer.from([0xfe, 0xff]), body])
    }
    case 'gbk':
      return iconv.encode(text, 'gb18030')
    default:
      return Buffer.from(text, 'utf8')
  }
}

// 严格编码：把文本按目标编码编码后，再解码回来与原文比对，确保「无损往返」。
// 若不一致（如往 GBK 文件里写入 emoji / 该编码无法表示的字符），返回 lossy=true，
// 上层据此拒绝写入并报错，绝不产生乱码落盘。ok 时 data 为可安全写盘的字节。
export function encodeTextStrict(
  text: string,
  encoding: FileEncoding
): { ok: true; data: Buffer } | { ok: false; lossy: true } {
  const data = encodeText(text, encoding)
  const roundTrip = decodeText(data, encoding)
  if (roundTrip === text) return { ok: true, data }
  return { ok: false, lossy: true }
}


export async function writeFileAtomic(target: string, data: Buffer): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, target)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}


export async function writeTextFile(
  target: string,
  content: string,
  encoding: FileEncoding = 'utf8'
): Promise<void> {
  // 落盘最后一道闸：严格往返校验。若新内容无法用目标编码无损表示，直接抛错而非写出乱码，
  // 保证任何写入路径（含绕过工具层的调用）都不会因编码不一致损坏文件。
  const res = encodeTextStrict(content, encoding)
  if (!res.ok) {
    throw new Error(
      `编码不一致：内容无法用 ${encoding} 无损编码，已中止写入以避免乱码（${target}）`
    )
  }
  await writeFileAtomic(target, res.data)
}


export async function readFileSafe(filePath: string): Promise<ReadFileResult> {
  try {
    const stat = await fs.stat(filePath)
    const size = stat.size
    const imageMime = IMAGE_EXT[extOf(filePath)]

    if (imageMime) {
      if (size > MAX_IMAGE_BYTES) return { ok: true, kind: 'image', size, tooLarge: true }
      const buf = await fs.readFile(filePath)
      return {
        ok: true,
        kind: 'image',
        size,
        dataUrl: `data:${imageMime};base64,${buf.toString('base64')}`
      }
    }

    if (size > MAX_TEXT_BYTES) return { ok: true, kind: 'text', size, tooLarge: true }

    const buf = await fs.readFile(filePath)
    const { encoding, binary } = detectEncoding(buf)
    if (binary) return { ok: true, kind: 'binary', size }
    return { ok: true, kind: 'text', size, encoding, content: decodeText(buf, encoding) }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}


export async function buildIgnore(root: string): Promise<Ignore | null> {
  try {
    const content = await fs.readFile(join(root, '.gitignore'), 'utf-8')
    return ignore().add(content)
  } catch {
    return null
  }
}


export function toRel(root: string, full: string): string {
  return full.slice(root.length).replace(/^[\\/]/, '').split('\\').join('/')
}

async function listFilesInto(
  root: string,
  dir: string,
  out: string[],
  ig: Ignore | null,
  depth = 0
): Promise<void> {
  if (depth > 40 || out.length >= 50000) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    const isDir = entry.isDirectory()
    if (ig) {
      const rel = toRel(root, fullPath) + (isDir ? '/' : '')
      if (rel && ig.ignores(rel)) continue
    }
    if (isDir) {
      await listFilesInto(root, fullPath, out, ig, depth + 1)
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(fullPath)
      if (out.length >= 50000) return
    }
  }
}


export async function listFiles(rootPath: string): Promise<string[]> {
  const out: string[] = []
  const ig = await buildIgnore(rootPath)
  await listFilesInto(rootPath, rootPath, out, ig)
  return out
}


export function errMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e) {
    const code = (e as { code: string }).code
    switch (code) {
      case 'EEXIST':
        return '同名文件或文件夹已存在'
      case 'ENOENT':
        return '路径不存在'
      case 'EPERM':
      case 'EACCES':
        return '没有权限执行该操作'
      case 'ENOTEMPTY':
        return '文件夹非空'
      case 'EBUSY':
        return '文件正被占用'
      default:
        return `操作失败 (${code})`
    }
  }
  return e instanceof Error ? e.message : '未知错误'
}
