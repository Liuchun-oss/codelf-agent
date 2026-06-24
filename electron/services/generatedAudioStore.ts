import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import { toArtifactUrl } from './artifactFileServer'

// 模型合成的语音落盘到 userData/generated-audio，通过 codelf-artifact:// 协议播放。
function generatedAudioDir(): string {
  return join(app.getPath('userData'), 'generated-audio')
}

function extForEncoding(encoding: string): string {
  const e = encoding.toLowerCase()
  if (e.includes('wav')) return 'wav'
  if (e.includes('ogg') || e.includes('opus')) return 'ogg'
  if (e.includes('pcm')) return 'pcm'
  if (e.includes('flac')) return 'flac'
  return 'mp3'
}

export interface SavedGeneratedAudio {
  filePath: string
  url: string
}

export async function saveGeneratedAudio(
  data: Buffer,
  encoding = 'mp3'
): Promise<SavedGeneratedAudio> {
  const dir = generatedAudioDir()
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `tts-${Date.now()}-${randomUUID()}.${extForEncoding(encoding)}`)
  await writeFile(filePath, data)
  return { filePath, url: toArtifactUrl(filePath) }
}
