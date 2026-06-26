// 微信入站媒体下载 + AES-128-ECB 解密。
// 复刻自腾讯官方插件 src/cdn/pic-decrypt.ts。
import crypto from 'node:crypto'

import { CDN_BASE_URL } from './api'

function buildCdnDownloadUrl(encryptedQueryParam: string): string {
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}

// 解析 CDNMedia.aes_key 为原始 16 字节 key。
// 两种编码：base64(raw16)（图片）或 base64(hex32)（文件/语音/视频）。
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`aes_key 必须解码为 16 字节或 32 位 hex 串，实得 ${decoded.length} 字节`)
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

async function fetchCdnBytes(url: string, label: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)')
    throw new Error(`${label}: CDN 下载 ${res.status} ${res.statusText} body=${body}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

// 下载并 AES-128-ECB 解密一份 CDN 媒体，返回明文 Buffer。
export async function downloadAndDecrypt(opts: {
  encryptedQueryParam?: string
  aesKeyBase64: string
  fullUrl?: string
  label: string
}): Promise<Buffer> {
  const key = parseAesKey(opts.aesKeyBase64)
  const url = opts.fullUrl || buildCdnDownloadUrl(opts.encryptedQueryParam ?? '')
  const encrypted = await fetchCdnBytes(url, opts.label)
  return decryptAesEcb(encrypted, key)
}

// 下载未加密的 CDN 媒体（无 aes_key 时）。
export async function downloadPlain(opts: {
  encryptedQueryParam?: string
  fullUrl?: string
  label: string
}): Promise<Buffer> {
  const url = opts.fullUrl || buildCdnDownloadUrl(opts.encryptedQueryParam ?? '')
  return fetchCdnBytes(url, opts.label)
}
