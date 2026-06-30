// 微信 iLink Bot API HTTP 客户端。
// 复刻自阶段 0 验证脚本 scripts/weixin-probe/weixinApi.mjs（已验证可跑通）。
// 协议参考：腾讯官方插件 @tencent-weixin/openclaw-weixin@2.1.1。

import crypto from 'node:crypto'
import type {
  GetUpdatesResponse,
  QrCodeResponse,
  QrStatusResponse,
  WeixinMessage,
  WeixinMessageItem
} from './types'
import { MessageItemType, MessageState, MessageType } from './types'

export const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_ILINK_BOT_TYPE = '3'

const ILINK_APP_ID = 'bot'
const CHANNEL_VERSION = '2.1.1'

function buildClientVersion(v: string): number {
  const [a = 0, b = 0, c = 0] = v.split('.').map((x) => parseInt(x, 10))
  return ((a & 0xff) << 16) | ((b & 0xff) << 8) | (c & 0xff)
}
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION)

function ensureTrailingSlash(u: string): string {
  return u.endsWith('/') ? u : `${u}/`
}

function randomWechatUin(): string {
  const n = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(n), 'utf-8').toString('base64')
}

function buildBaseInfo(): { channel_version: string } {
  return { channel_version: CHANNEL_VERSION }
}

function commonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION)
  }
}

function authHeaders(token: string | undefined, body: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
    'X-WECHAT-UIN': randomWechatUin(),
    ...commonHeaders()
  }
  if (token?.trim()) h.Authorization = `Bearer ${token.trim()}`
  return h
}

async function getFetch(opts: {
  baseUrl: string
  endpoint: string
  timeoutMs: number
  label: string
}): Promise<string> {
  const url = new URL(opts.endpoint, ensureTrailingSlash(opts.baseUrl))
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), opts.timeoutMs)
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: commonHeaders(),
      signal: ac.signal
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${opts.label} ${res.status}: ${text}`)
    return text
  } finally {
    clearTimeout(t)
  }
}

async function postFetch(opts: {
  baseUrl: string
  endpoint: string
  body: string
  token?: string
  timeoutMs: number
  label: string
  signal?: AbortSignal
}): Promise<string> {
  const url = new URL(opts.endpoint, ensureTrailingSlash(opts.baseUrl))
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), opts.timeoutMs)
  // 外部 abort（停止长轮询）联动内部 controller。
  const onExternalAbort = (): void => ac.abort()
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort()
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: authHeaders(opts.token, opts.body),
      body: opts.body,
      signal: ac.signal
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${opts.label} ${res.status}: ${text}`)
    return text
  } finally {
    clearTimeout(t)
    if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort)
  }
}

// --- 扫码登录 ---

export async function fetchQrCode(botType = DEFAULT_ILINK_BOT_TYPE): Promise<QrCodeResponse> {
  const raw = await getFetch({
    baseUrl: FIXED_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    timeoutMs: 8000,
    label: 'get_bot_qrcode'
  })
  return JSON.parse(raw) as QrCodeResponse
}

export async function pollQrStatus(baseUrl: string, qrcode: string): Promise<QrStatusResponse> {
  try {
    const raw = await getFetch({
      baseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs: 35000,
      label: 'get_qrcode_status'
    })
    return JSON.parse(raw) as QrStatusResponse
  } catch {
    return { status: 'wait' }
  }
}

// --- 收发消息 ---

export async function getUpdates(opts: {
  baseUrl: string
  token: string
  get_updates_buf?: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<GetUpdatesResponse> {
  try {
    const raw = await postFetch({
      baseUrl: opts.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: opts.get_updates_buf ?? '',
        base_info: buildBaseInfo()
      }),
      token: opts.token,
      timeoutMs: opts.timeoutMs ?? 35000,
      label: 'getUpdates',
      signal: opts.signal
    })
    return JSON.parse(raw) as GetUpdatesResponse
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: opts.get_updates_buf }
    }
    throw err
  }
}

export async function sendText(opts: {
  baseUrl: string
  token: string
  to: string
  text: string
  contextToken?: string
  timeoutMs?: number
}): Promise<{ clientId: string }> {
  const clientId = `codelf-wx-${crypto.randomUUID()}`
  const items: WeixinMessageItem[] | undefined = opts.text
    ? [{ type: MessageItemType.TEXT, text_item: { text: opts.text } }]
    : undefined
  const body = JSON.stringify({
    msg: {
      from_user_id: '',
      to_user_id: opts.to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: items,
      context_token: opts.contextToken ?? undefined
    },
    base_info: buildBaseInfo()
  })
  await postFetch({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body,
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? 15000,
    label: 'sendMessage'
  })
  return { clientId }
}

// 上传媒体类型（getuploadurl 的 media_type）。
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const

// CDN 上传地址固定常量（复刻自腾讯插件 accounts.ts）。
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

export interface GetUploadUrlResponse {
  upload_param?: string
  thumb_upload_param?: string
  upload_full_url?: string
}

// 申请 CDN 上传预签名 URL（getuploadurl）。
export async function getUploadUrl(opts: {
  baseUrl: string
  token: string
  filekey: string
  mediaType: number
  toUserId: string
  rawsize: number
  rawfilemd5: string
  filesize: number
  aeskey: string
  timeoutMs?: number
}): Promise<GetUploadUrlResponse> {
  const raw = await postFetch({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    body: JSON.stringify({
      filekey: opts.filekey,
      media_type: opts.mediaType,
      to_user_id: opts.toUserId,
      rawsize: opts.rawsize,
      rawfilemd5: opts.rawfilemd5,
      filesize: opts.filesize,
      no_need_thumb: true,
      aeskey: opts.aeskey,
      base_info: buildBaseInfo()
    }),
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? 15000,
    label: 'getUploadUrl'
  })
  return JSON.parse(raw) as GetUploadUrlResponse
}

// 已上传的图片信息（CDN 引用），用于拼装 IMAGE 消息项。
export interface UploadedImageInfo {
  downloadEncryptedQueryParam: string
  // AES key 的 hex 串。
  aeskeyHex: string
  // 密文大小（AES-128-ECB PKCS7 补齐后）。
  fileSizeCiphertext: number
  // 明文原始大小（字节）。文件/视频消息项需要。
  rawSize?: number
  // 明文 MD5 的 hex 串。文件消息项需要。
  rawMd5Hex?: string
}

// 发送图片消息（先 CDN 上传得到 UploadedImageInfo，再调本函数）。
export async function sendImageMessage(opts: {
  baseUrl: string
  token: string
  to: string
  uploaded: UploadedImageInfo
  contextToken?: string
  timeoutMs?: number
}): Promise<{ clientId: string }> {
  const clientId = `codelf-wx-${crypto.randomUUID()}`
  const body = JSON.stringify({
    msg: {
      from_user_id: '',
      to_user_id: opts.to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [
        {
          type: MessageItemType.IMAGE,
          image_item: {
            media: {
              encrypt_query_param: opts.uploaded.downloadEncryptedQueryParam,
              // 注意：协议要求 aes_key 为 hex 串再 base64（复刻自腾讯插件 send.ts）。
              aes_key: Buffer.from(opts.uploaded.aeskeyHex).toString('base64'),
              encrypt_type: 1
            },
            mid_size: opts.uploaded.fileSizeCiphertext
          }
        }
      ],
      context_token: opts.contextToken ?? undefined
    },
    base_info: buildBaseInfo()
  })
  await postFetch({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body,
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? 15000,
    label: 'sendImageMessage'
  })
  return { clientId }
}

// 发送文件消息（先 CDN 上传得到 UploadedImageInfo，再调本函数）。
// 文件项需要 file_name / md5 / len（明文大小），media 引用与图片一致。
export async function sendFileMessage(opts: {
  baseUrl: string
  token: string
  to: string
  uploaded: UploadedImageInfo
  fileName: string
  contextToken?: string
  timeoutMs?: number
}): Promise<{ clientId: string }> {
  const clientId = `codelf-wx-${crypto.randomUUID()}`
  const body = JSON.stringify({
    msg: {
      from_user_id: '',
      to_user_id: opts.to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [
        {
          type: MessageItemType.FILE,
          file_item: {
            media: {
              encrypt_query_param: opts.uploaded.downloadEncryptedQueryParam,
              aes_key: Buffer.from(opts.uploaded.aeskeyHex).toString('base64'),
              encrypt_type: 1
            },
            file_name: opts.fileName,
            md5: opts.uploaded.rawMd5Hex,
            len: opts.uploaded.rawSize != null ? String(opts.uploaded.rawSize) : undefined
          }
        }
      ],
      context_token: opts.contextToken ?? undefined
    },
    base_info: buildBaseInfo()
  })
  await postFetch({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body,
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? 20000,
    label: 'sendFileMessage'
  })
  return { clientId }
}

// 拉取 bot 配置（含 typing_ticket，用于"正在输入"状态）。
export async function getConfig(opts: {
  baseUrl: string
  token: string
  ilinkUserId: string
  contextToken?: string
  timeoutMs?: number
}): Promise<{ typing_ticket?: string }> {
  const raw = await postFetch({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: JSON.stringify({
      ilink_user_id: opts.ilinkUserId,
      context_token: opts.contextToken,
      base_info: buildBaseInfo()
    }),
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? 10000,
    label: 'getConfig'
  })
  return JSON.parse(raw) as { typing_ticket?: string }
}

// 发送"正在输入"状态。status：1=输入中，2=取消。
export async function sendTyping(opts: {
  baseUrl: string
  token: string
  ilinkUserId: string
  typingTicket: string
  status: number
  timeoutMs?: number
}): Promise<void> {
  await postFetch({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body: JSON.stringify({
      ilink_user_id: opts.ilinkUserId,
      typing_ticket: opts.typingTicket,
      status: opts.status,
      base_info: buildBaseInfo()
    }),
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? 10000,
    label: 'sendTyping'
  })
}

// 从一条入站 WeixinMessage 提取纯文本。
export function extractText(msg: WeixinMessage): string {
  const items = msg?.item_list ?? []
  const parts: string[] = []
  for (const it of items) {
    if (it?.type === MessageItemType.TEXT && it.text_item?.text) parts.push(it.text_item.text)
  }
  return parts.join('\n')
}
