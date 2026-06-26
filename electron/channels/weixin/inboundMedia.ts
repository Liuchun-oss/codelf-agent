// 微信入站媒体处理：解析一条消息里的图片/语音/文件/视频项，
// 下载解密后转成可喂给 QueryEngine 的形式（图片→dataUrl，文件/语音/视频→落盘+路径提示）。
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

import { MessageItemType } from './types'
import type { WeixinMessage, CDNMedia } from './types'
import { downloadAndDecrypt, downloadPlain } from './mediaDownload'
import { silkToWav } from './silkTranscode'

export interface InboundMediaResult {
  // 作为多模态视觉内容喂给模型的图片。
  images: { dataUrl: string; name?: string }[]
  // 追加到用户消息文本后的提示行（文件/语音/视频的本地路径等）。
  noteLines: string[]
}

function inboundMediaDir(): string {
  return join(app.getPath('userData'), 'weixin-inbound')
}

// 暴露入站媒体目录路径（供 /diag 自检显示）。
export function getInboundMediaDir(): string {
  return inboundMediaDir()
}

// 取媒体的 aes_key（优先 image_item.aeskey 的 hex，转 base64；否则用 media.aes_key）。
function resolveAesKeyBase64(media: CDNMedia | undefined, aeskeyHex?: string): string | undefined {
  if (aeskeyHex) return Buffer.from(aeskeyHex, 'hex').toString('base64')
  return media?.aes_key
}

async function saveInbound(buf: Buffer, ext: string): Promise<string> {
  const dir = inboundMediaDir()
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `wx-${Date.now()}-${randomUUID()}.${ext}`)
  await writeFile(filePath, buf)
  return filePath
}

// 处理一条入站消息的所有媒体项。best-effort：单项失败仅记 note，不抛出。
export async function processInboundMedia(
  msg: WeixinMessage,
  log: (m: string) => void
): Promise<InboundMediaResult> {
  const result: InboundMediaResult = { images: [], noteLines: [] }
  const items = msg?.item_list ?? []

  for (const item of items) {
    try {
      if (item.type === MessageItemType.IMAGE) {
        const img = item.image_item
        const media = img?.media
        if (!media?.encrypt_query_param && !media?.full_url) continue
        const aesKeyBase64 = resolveAesKeyBase64(media, img?.aeskey)
        const buf = aesKeyBase64
          ? await downloadAndDecrypt({
              encryptedQueryParam: media.encrypt_query_param,
              aesKeyBase64,
              fullUrl: media.full_url,
              label: '入站图片'
            })
          : await downloadPlain({
              encryptedQueryParam: media.encrypt_query_param,
              fullUrl: media.full_url,
              label: '入站图片(明文)'
            })
        result.images.push({ dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, name: 'weixin-image.jpg' })
        log(`入站图片已下载解密 ${buf.length} 字节`)
      } else if (item.type === MessageItemType.VOICE) {
        const voice = item.voice_item
        const media = voice?.media
        if ((!media?.encrypt_query_param && !media?.full_url) || !media?.aes_key) continue
        // 服务端若已带转写文本，直接用。
        if (voice?.text?.trim()) {
          result.noteLines.push(`[语音转文字] ${voice.text.trim()}`)
          continue
        }
        const silkBuf = await downloadAndDecrypt({
          encryptedQueryParam: media.encrypt_query_param,
          aesKeyBase64: media.aes_key,
          fullUrl: media.full_url,
          label: '入站语音'
        })
        const wav = await silkToWav(silkBuf)
        const path = wav ? await saveInbound(wav, 'wav') : await saveInbound(silkBuf, 'silk')
        log(`入站语音已处理：silk=${silkBuf.length}字节 转码=${wav ? '成功(WAV)' : '降级(silk)'} 路径=${path}`)
        result.noteLines.push(
          wav
            ? `[用户发来一条语音，已转码为 WAV，本地路径：${path}]`
            : `[用户发来一条语音，silk 转码不可用，原始文件路径：${path}]`
        )
      } else if (item.type === MessageItemType.FILE) {
        const f = item.file_item
        const media = f?.media
        if ((!media?.encrypt_query_param && !media?.full_url) || !media?.aes_key) continue
        const buf = await downloadAndDecrypt({
          encryptedQueryParam: media.encrypt_query_param,
          aesKeyBase64: media.aes_key,
          fullUrl: media.full_url,
          label: '入站文件'
        })
        const name = f?.file_name ?? 'file.bin'
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
        const path = await saveInbound(buf, ext)
        result.noteLines.push(`[用户发来文件「${name}」，本地路径：${path}]`)
        log(`入站文件已下载解密「${name}」${buf.length}字节 → ${path}`)
      } else if (item.type === MessageItemType.VIDEO) {
        const v = item.video_item
        const media = v?.media
        if ((!media?.encrypt_query_param && !media?.full_url) || !media?.aes_key) continue
        const buf = await downloadAndDecrypt({
          encryptedQueryParam: media.encrypt_query_param,
          aesKeyBase64: media.aes_key,
          fullUrl: media.full_url,
          label: '入站视频'
        })
        const path = await saveInbound(buf, 'mp4')
        result.noteLines.push(`[用户发来一段视频，本地路径：${path}]`)
        log(`入站视频已下载解密 ${buf.length}字节 → ${path}`)
      }
    } catch (e) {
      log(`入站媒体处理失败：${String(e)}`)
    }
  }

  return result
}
