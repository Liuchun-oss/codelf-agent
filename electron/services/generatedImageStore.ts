import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join, isAbsolute, resolve as resolvePath, extname, dirname, basename } from 'path'
import { app } from 'electron'
import { toArtifactUrl } from './artifactFileServer'

// 模型生成的图片落盘到 userData/generated-images，通过 codelf-artifact:// 协议
// （文件系统支撑）渲染，重启后仍可显示，避免内存预览 map 在重启后失效。
function generatedImagesDir(): string {
  return join(app.getPath('userData'), 'generated-images')
}

function extForMime(mime: string): string {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  return 'png'
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

export interface SavedGeneratedImage {
  filePath: string
  url: string
}

export interface SaveImageTarget {
  // agent 指定的输出文件路径（含文件名+扩展名），绝对或工作区相对。
  outputPath?: string
  workspaceRoot?: string | null
  // 一次生成多张时为 true：文件名会在扩展名前追加 -1/-2… 区分。
  multi?: boolean
}

// 把 agent 指定的 outputPath 解析为最终落盘文件路径。
// - 绝对路径直接用；相对路径基于 workspaceRoot。
// - multi=true 时在扩展名前插入 -{index+1}（icon.png → icon-1.png）。
// - 缺扩展名时按 mime 补。
function resolveImageOutputPath(
  target: SaveImageTarget,
  mime: string,
  index: number
): string | null {
  const raw = target.outputPath?.trim()
  if (!raw) return null
  let p = raw
  if (!isAbsolute(p)) {
    if (!target.workspaceRoot) return null
    p = resolvePath(target.workspaceRoot, p)
  }
  const ext = extForMime(mime)
  const dir = dirname(p)
  let name = basename(p)
  let nameExt = extname(name)
  // 缺少图片扩展名时补 mime 对应扩展名。
  if (!IMAGE_EXTS.has(nameExt.toLowerCase())) {
    name = `${name}.${ext}`
    nameExt = `.${ext}`
  }
  if (target.multi) {
    const stem = name.slice(0, name.length - nameExt.length)
    name = `${stem}-${index + 1}${nameExt}`
  }
  return join(dir, name)
}

export async function saveGeneratedImage(
  base64: string,
  mime = 'image/png',
  target?: SaveImageTarget,
  index = 0
): Promise<SavedGeneratedImage> {
  const resolved = target ? resolveImageOutputPath(target, mime, index) : null
  const filePath =
    resolved ??
    join(generatedImagesDir(), `img-${Date.now()}-${randomUUID()}.${extForMime(mime)}`)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, Buffer.from(base64, 'base64'))
  return { filePath, url: toArtifactUrl(filePath) }
}
