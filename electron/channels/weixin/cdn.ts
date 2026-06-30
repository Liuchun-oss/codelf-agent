// 微信 CDN 媒体上传：AES-128-ECB 加密 + 上传 + 拼装下载参数。
// 复刻自腾讯官方插件 src/cdn/* 与 src/messaging/send-media.ts。
import crypto from 'node:crypto'

import { CDN_BASE_URL, getUploadUrl, UploadMediaType } from './api'
import type { UploadedImageInfo } from './api'

const UPLOAD_MAX_RETRIES = 3

// AES-128-ECB 加密（默认 PKCS7 补齐）。
function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

// AES-128-ECB 密文大小（PKCS7 补齐到 16 字节边界）。
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

function buildCdnUploadUrl(uploadParam: string, filekey: string): string {
  return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

// 把加密后的密文 POST 到 CDN，返回下载用的 encrypted_query_param。
async function uploadBufferToCdn(opts: {
  ciphertext: Buffer
  uploadFullUrl?: string
  uploadParam?: string
  filekey: string
}): Promise<string> {
  const trimmedFull = opts.uploadFullUrl?.trim()
  let cdnUrl: string
  if (trimmedFull) {
    cdnUrl = trimmedFull
  } else if (opts.uploadParam) {
    cdnUrl = buildCdnUploadUrl(opts.uploadParam, opts.filekey)
  } else {
    throw new Error('CDN 上传地址缺失（需要 upload_full_url 或 upload_param）')
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(opts.ciphertext)
      })
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get('x-error-message') ?? (await res.text())
        throw new Error(`CDN 上传客户端错误 ${res.status}: ${errMsg}`)
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get('x-error-message') ?? `status ${res.status}`
        throw new Error(`CDN 上传服务端错误: ${errMsg}`)
      }
      const downloadParam = res.headers.get('x-encrypted-param') ?? undefined
      if (!downloadParam) throw new Error('CDN 响应缺少 x-encrypted-param 头')
      return downloadParam
    } catch (err) {
      lastError = err
      if (err instanceof Error && err.message.includes('客户端错误')) throw err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`CDN 上传在 ${UPLOAD_MAX_RETRIES} 次尝试后仍失败`)
}

// 上传一张图片（明文 Buffer）到微信 CDN，返回拼装 IMAGE 消息所需信息。
export async function uploadImageBuffer(opts: {
  baseUrl: string
  token: string
  toUserId: string
  buf: Buffer
  log?: (m: string) => void
}): Promise<UploadedImageInfo> {
  return uploadMediaBuffer({ ...opts, mediaType: UploadMediaType.IMAGE, label: '发图' })
}

// 上传任意媒体（明文 Buffer）到微信 CDN。图片/文件/视频/语音共用同一套上传流程，
// 仅 media_type 不同。返回拼装出站消息项所需的 CDN 引用信息。
export async function uploadMediaBuffer(opts: {
  baseUrl: string
  token: string
  toUserId: string
  buf: Buffer
  mediaType: number
  label?: string
  log?: (m: string) => void
}): Promise<UploadedImageInfo> {
  const tag = opts.label ?? '发送媒体'
  const rawsize = opts.buf.length
  const rawfilemd5 = crypto.createHash('md5').update(opts.buf).digest('hex')
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = crypto.randomBytes(16).toString('hex')
  const aeskey = crypto.randomBytes(16)
  opts.log?.(`[${tag}] 申请上传地址 rawsize=${rawsize} filesize=${filesize} filekey=${filekey.slice(0, 8)}…`)

  const resp = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    filekey,
    mediaType: opts.mediaType,
    toUserId: opts.toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString('hex')
  })

  const uploadFullUrl = resp.upload_full_url?.trim()
  const uploadParam = resp.upload_param
  if (!uploadFullUrl && !uploadParam) {
    throw new Error('getUploadUrl 未返回上传地址')
  }

  const ciphertext = encryptAesEcb(opts.buf, aeskey)
  const downloadEncryptedQueryParam = await uploadBufferToCdn({
    ciphertext,
    uploadFullUrl: uploadFullUrl || undefined,
    uploadParam: uploadParam ?? undefined,
    filekey
  })
  opts.log?.(`[${tag}] CDN 上传成功 filekey=${filekey.slice(0, 8)}… rawmd5=${rawfilemd5.slice(0, 8)}…`)

  return {
    downloadEncryptedQueryParam,
    aeskeyHex: aeskey.toString('hex'),
    fileSizeCiphertext: filesize,
    rawSize: rawsize,
    rawMd5Hex: rawfilemd5
  }
}

// 解析 data URL（data:image/png;base64,xxxx）为 Buffer。返回 null 表示无法解析。
export function dataUrlToBuffer(dataUrl: string): Buffer | null {
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(dataUrl)
  if (!m) return null
  try {
    return Buffer.from(m[1], 'base64')
  } catch {
    return null
  }
}
