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


// 校验 buffer 是否为合法 UTF-8 字节序列。用于区分「无 BOM 的 UTF-8」与「GBK 等旧编码」。
//
// 关键：必须对「完整 buffer」校验，或在多字节字符边界处安全截断，绝不能在任意字节位置
// 截断样本——否则一个正常 UTF-8 中文文件若恰好在样本末尾切到某个汉字中间（UTF-8 汉字占
// 3 字节），会被误判为非法 UTF-8 → 误判成 GBK → 编辑时沿用错误编码把文件写成乱码。
// 这正是「有中文就大概率写坏」的根因。这里对全量 buffer 校验（文本文件已受 16MB 上限约束，
// 一次线性扫描成本可忽略），从根上消除截断误判。
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

// 二进制探测：只看是否含 NUL 字节（文本文件不含 \0）。对完整 buffer 检查。
function hasNulByte(buf: Buffer): boolean {
  const scanLen = Math.min(buf.length, 65_536)
  for (let i = 0; i < scanLen; i++) if (buf[i] === 0) return true
  return false
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
  if (hasNulByte(buf)) return { encoding: 'utf8', binary: true }
  // 判定强烈偏向 UTF-8（现代文件的绝对主流）：全量合法 UTF-8（含纯 ASCII）一律判 UTF-8。
  // 只有「确实不是合法 UTF-8」才考虑 GBK——此时再要求它能被 gb18030 无损解码才采纳，
  // 否则仍回退 UTF-8。宁可偶尔把真 GBK 当 UTF-8（读出乱码、明显可见、不会写坏），
  // 也绝不把真 UTF-8 误判成 GBK（会静默写坏文件）。
  if (isValidUtf8(buf)) return { encoding: 'utf8', binary: false }
  if (looksLikeGbk(buf)) return { encoding: 'gbk', binary: false }
  return { encoding: 'utf8', binary: false }
}

// 保守判断 buffer 是否确实像 GBK：用 gb18030 解码后不含替换字符（U+FFFD），
// 且解码结果里出现了中日韩汉字。二者兼备才认定 GBK，避免把「碰巧非法 UTF-8 的
// 二进制边角/其它编码」误当成 GBK。
function looksLikeGbk(buf: Buffer): boolean {
  try {
    const decoded = iconv.decode(buf.subarray(0, Math.min(buf.length, 65_536)), 'gb18030')
    if (decoded.includes('\uFFFD')) return false
    return /[\u4e00-\u9fff]/.test(decoded)
  } catch {
    return false
  }
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
  // 落盘闸门一：写前复核磁盘上目标文件的「实际当前编码」，必须与本次要写的 encoding 一致。
  // 覆盖已存在的文本文件时，若两者不符（例如决策时的探测与此刻磁盘状态不一致，或存在竞态），
  // 直接中止——绝不用另一种编码覆盖原文件，从源头保证「写入编码 == 原文件编码」。
  try {
    const stat = await fs.stat(target)
    if (stat.isFile() && stat.size > 0 && stat.size <= MAX_TEXT_BYTES) {
      const existing = await fs.readFile(target)
      const det = detectEncoding(existing)
      if (!det.binary && det.encoding !== encoding) {
        throw new Error(
          `编码不一致：目标文件当前实际编码为 ${det.encoding}，本次写入声明为 ${encoding}，` +
            `已中止写入以避免损坏原文件（${target}）。请以文件实际编码重新生成写入内容。`
        )
      }
    }
  } catch (e) {
    // stat 失败（文件不存在=新建）属正常路径；只有主动抛出的编码不一致错误需要向上传播。
    if (e instanceof Error && e.message.startsWith('编码不一致')) throw e
  }

  // 落盘闸门二：严格往返校验。若新内容无法用目标编码无损表示，直接抛错而非写出乱码。
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
