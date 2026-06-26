// 微信长轮询主循环。复刻自阶段 0 验证脚本 probe.mjs 的 monitor()。
// 见策划书 4.3。退避策略：连续 3 次失败后退避 30s；
// 检测到会话过期（errcode -14）回调 onExpired 并停止（D14）。

import { getUpdates, extractText } from './api'
import { SESSION_EXPIRED_ERRCODE, MessageType } from './types'
import type { WeixinMessage } from './types'
import { saveCursor } from './account'

export interface MonitorCallbacks {
  // 收到一条用户消息（已过滤掉 bot 自己发的）。
  onMessage: (msg: { from: string; text: string; contextToken?: string; raw: WeixinMessage }) => void
  // 会话过期（errcode -14），需要重新扫码。
  onExpired: () => void
  // 运行错误提示（仅用于 UI/日志，不致命）。
  onError?: (message: string) => void
  log?: (message: string) => void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class WeixinMonitor {
  private aborted = false
  private controller = new AbortController()

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private initialBuf: string,
    private readonly cb: MonitorCallbacks
  ) {}

  stop(): void {
    this.aborted = true
    this.controller.abort()
  }

  async run(): Promise<void> {
    let buf = this.initialBuf ?? ''
    let fails = 0
    this.cb.log?.('开始长轮询收消息')

    while (!this.aborted) {
      let resp
      try {
        resp = await getUpdates({
          baseUrl: this.baseUrl,
          token: this.token,
          get_updates_buf: buf,
          signal: this.controller.signal
        })
      } catch (err) {
        if (this.aborted) break
        fails++
        this.cb.onError?.(`长轮询网络错误（${fails}）：${String(err)}`)
        await sleep(fails >= 3 ? 30_000 : 2000)
        if (fails >= 3) fails = 0
        continue
      }

      const isErr = (resp.ret && resp.ret !== 0) || (resp.errcode && resp.errcode !== 0)
      if (isErr) {
        if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
          this.cb.log?.('会话已过期（errcode -14），停止轮询')
          this.cb.onExpired()
          return
        }
        fails++
        this.cb.onError?.(`长轮询业务错误 ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ''}`)
        await sleep(fails >= 3 ? 30_000 : 2000)
        if (fails >= 3) fails = 0
        continue
      }
      fails = 0

      // 推进并持久化游标（断点续传）。
      if (resp.get_updates_buf != null && resp.get_updates_buf !== '') {
        buf = resp.get_updates_buf
        saveCursor(buf)
      }

      for (const msg of resp.msgs ?? []) {
        // 只处理用户发来的，忽略 bot 自己发的，避免回声循环。
        if (msg.message_type === MessageType.BOT) continue
        const text = extractText(msg)
        const from = msg.from_user_id
        if (!from) continue
        this.cb.onMessage({ from, text, contextToken: msg.context_token, raw: msg })
      }
    }
  }
}
