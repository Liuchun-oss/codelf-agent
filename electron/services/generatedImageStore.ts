import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
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

export interface SavedGeneratedImage {
  filePath: string
  url: string
}

export async function saveGeneratedImage(
  base64: string,
  mime = 'image/png'
): Promise<SavedGeneratedImage> {
  const dir = generatedImagesDir()
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `img-${Date.now()}-${randomUUID()}.${extForMime(mime)}`)
  await writeFile(filePath, Buffer.from(base64, 'base64'))
  return { filePath, url: toArtifactUrl(filePath) }
}
