import { randomUUID } from 'crypto'
import { mkdir, writeFile, stat } from 'fs/promises'
import { join, isAbsolute, resolve as resolvePath, extname, dirname } from 'path'
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

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v'])

export interface SavedGeneratedVideo {
  filePath: string
  url: string
}

export interface SaveVideoTarget {
  // agent 指定的输出路径：可为目录或完整文件路径，支持工作区相对路径或绝对路径。
  outputPath?: string
  workspaceRoot?: string | null
}

// 把 agent 指定的 outputPath 解析为最终落盘的绝对文件路径。
// - 绝对路径直接用；相对路径基于 workspaceRoot 解析。
// - 若指向目录（已存在的目录，或无视频扩展名），则在其中生成带扩展名的文件名。
// - 若是带视频扩展名的路径，则当作完整文件路径（自动补正确扩展名以匹配 mime）。
async function resolveOutputFilePath(
  target: SaveVideoTarget,
  mime: string
): Promise<string | { error: string }> {
  const ext = extForMime(mime)
  const raw = target.outputPath?.trim()
  if (!raw) {
    return join(generatedVideosDir(), `vid-${Date.now()}-${randomUUID()}.${ext}`)
  }

  let p = raw
  if (!isAbsolute(p)) {
    if (!target.workspaceRoot) {
      return { error: `outputPath 是相对路径但缺少工作区根，无法解析：${raw}` }
    }
    p = resolvePath(target.workspaceRoot, p)
  }

  // 判断是目录还是文件：已存在目录、以分隔符结尾、或没有视频扩展名 → 当目录。
  const endsWithSep = /[\\/]$/.test(raw)
  const lowerExt = extname(p).toLowerCase()
  let isDir = endsWithSep
  if (!isDir) {
    try {
      const s = await stat(p)
      if (s.isDirectory()) isDir = true
    } catch {
      // 不存在：按是否有视频扩展名判断。
      if (!VIDEO_EXTS.has(lowerExt)) isDir = true
    }
  }

  if (isDir) {
    return join(p, `vid-${Date.now()}-${randomUUID()}.${ext}`)
  }
  // 完整文件路径：扩展名不是视频扩展名时，补上 mime 对应扩展名。
  if (!VIDEO_EXTS.has(lowerExt)) return `${p}.${ext}`
  return p
}

export async function saveGeneratedVideo(
  data: Buffer,
  mime = 'video/mp4',
  target?: SaveVideoTarget
): Promise<SavedGeneratedVideo> {
  const resolved = await resolveOutputFilePath(target ?? {}, mime)
  if (typeof resolved !== 'string') {
    // 解析失败时回退到默认目录，确保视频不丢失。
    const fallback = join(generatedVideosDir(), `vid-${Date.now()}-${randomUUID()}.${extForMime(mime)}`)
    await mkdir(dirname(fallback), { recursive: true })
    await writeFile(fallback, data)
    return { filePath: fallback, url: toArtifactUrl(fallback) }
  }
  await mkdir(dirname(resolved), { recursive: true })
  await writeFile(resolved, data)
  return { filePath: resolved, url: toArtifactUrl(resolved) }
}
