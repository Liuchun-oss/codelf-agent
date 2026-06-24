import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import { toArtifactUrl } from './artifactFileServer'

// 模型生成的视频落盘到 userData/generated-videos，通过 codelf-artifact:// 协议渲染播放。
// 火山返回的是 24h 临时签名 URL，必须立即下载转存到本地，避免链接过期后无法播放。
function generatedVideosDir(): string {
  return join(app.getPath('userData'), 'generated-videos')
}

function extForMime(mime: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('quicktime') || mime.includes('mov')) return 'mov'
  return 'mp4'
}

export interface SavedGeneratedVideo {
  filePath: string
  url: string
}

export async function saveGeneratedVideo(
  data: Buffer,
  mime = 'video/mp4'
): Promise<SavedGeneratedVideo> {
  const dir = generatedVideosDir()
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `vid-${Date.now()}-${randomUUID()}.${extForMime(mime)}`)
  await writeFile(filePath, data)
  return { filePath, url: toArtifactUrl(filePath) }
}
