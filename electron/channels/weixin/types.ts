// 微信 iLink Bot API 协议类型（复刻自腾讯官方插件 @tencent-weixin/openclaw-weixin@2.1.1）。
// 见 docs/微信通讯接入策划书.md 第 4 节。

export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const
export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const
export const SESSION_EXPIRED_ERRCODE = -14
// 正在输入状态：1=输入中，2=取消。
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const

// CDN 媒体引用。aes_key 在 JSON 里是 base64 串（图片为 base64(raw16)，文件/语音/视频为 base64(hex32)）。
export interface CDNMedia {
  encrypt_query_param?: string
  aes_key?: string
  // 0=只加密 fileid，1=打包缩略图/中图等信息。
  encrypt_type?: number
  // 完整下载 URL（服务端直接返回，无需客户端拼接）。
  full_url?: string
}

export interface WeixinImageItem {
  media?: CDNMedia
  thumb_media?: CDNMedia
  // 原始 AES-128 key 的 hex 串（16 字节）；入站解密优先用它。
  aeskey?: string
  url?: string
  mid_size?: number
  hd_size?: number
}

export interface WeixinVoiceItem {
  media?: CDNMedia
  // 编码类型：6=silk 等。
  encode_type?: number
  sample_rate?: number
  // 语音长度（毫秒）。
  playtime?: number
  // 语音转文字内容（服务端若已转好）。
  text?: string
}

export interface WeixinFileItem {
  media?: CDNMedia
  file_name?: string
  md5?: string
  len?: string
}

export interface WeixinVideoItem {
  media?: CDNMedia
  video_size?: number
}

// 入站消息内容项。
export interface WeixinMessageItem {
  type: number
  text_item?: { text?: string }
  image_item?: WeixinImageItem
  voice_item?: WeixinVoiceItem
  file_item?: WeixinFileItem
  video_item?: WeixinVideoItem
}

// 入站 / 出站消息。
export interface WeixinMessage {
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  message_type?: number
  message_state?: number
  session_id?: string
  group_id?: string
  context_token?: string
  item_list?: WeixinMessageItem[]
}

// getUpdates 响应。
export interface GetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
}

// 扫码二维码响应。
export interface QrCodeResponse {
  qrcode?: string
  qrcode_img_content?: string
}

// 扫码状态轮询响应。
export interface QrStatusResponse {
  status?: 'wait' | 'scaned' | 'scaned_but_redirect' | 'expired' | 'confirmed' | string
  redirect_host?: string
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
}

// 持久化的登录凭证 + 同步游标。
export interface WeixinAccountState {
  token: string
  accountId: string
  // 机主 userId（主动通知默认接收人，见 7.7 #3）。
  userId?: string
  baseUrl: string
  // getUpdates 同步游标（断点续传水位线）。
  get_updates_buf: string
  savedAt: string
}
