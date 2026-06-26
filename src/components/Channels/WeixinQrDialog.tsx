import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { ChannelLoginState } from '@shared/channelTypes'
import AnimatedOverlay from '@/components/common/AnimatedOverlay'

interface Props {
  open: boolean
  onClose: () => void
  onConnected: (accountId?: string) => void
}

// 二维码登录对话框（7.6.4）。渲染二维码 + 实时状态文案，每秒轮询一次扫码状态，
// 过期自动刷新（最多 3 次）。
export default function WeixinQrDialog({ open, onClose, onConnected }: Props): JSX.Element | null {
  const [qrImg, setQrImg] = useState<string | null>(null)
  const [statusText, setStatusText] = useState('正在获取二维码…')
  const [expired, setExpired] = useState(false)
  const sessionKeyRef = useRef<string | null>(null)
  const pollingRef = useRef(false)
  const refreshCountRef = useRef(0)

  const begin = async (): Promise<void> => {
    setExpired(false)
    setQrImg(null)
    setStatusText('正在获取二维码…')
    try {
      const { qrcodeUrl, sessionKey } = await window.lc.channels.beginLogin()
      sessionKeyRef.current = sessionKey
      // qrcodeUrl 实为待编码进二维码的文本内容（一个链接），需本地渲染成二维码图片，
      // 不能直接当 <img src> 用（否则破图）。
      const dataUrl = await QRCode.toDataURL(qrcodeUrl, { width: 440, margin: 1 })
      setQrImg(dataUrl)
      setStatusText('等待扫码…')
    } catch (e) {
      setStatusText(`获取二维码失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  useEffect(() => {
    if (!open) return
    refreshCountRef.current = 0
    void begin()
    pollingRef.current = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async (): Promise<void> => {
      if (!pollingRef.current) return
      const key = sessionKeyRef.current
      if (!key) {
        timer = setTimeout(() => void tick(), 1000)
        return
      }
      let state: ChannelLoginState
      try {
        state = await window.lc.channels.pollLogin(key)
      } catch {
        state = { status: 'wait' }
      }
      if (!pollingRef.current) return
      switch (state.status) {
        case 'wait':
          break
        case 'scanned':
          setStatusText('✅ 已扫码，请在手机上确认')
          break
        case 'expired':
          if (refreshCountRef.current < 3) {
            refreshCountRef.current += 1
            await begin()
          } else {
            setExpired(true)
            setStatusText('二维码已过期，请点击刷新')
            return
          }
          break
        case 'confirmed':
          setStatusText('🎉 连接成功')
          pollingRef.current = false
          onConnected(state.accountId)
          return
        case 'error':
          setStatusText(state.message ?? '登录出错')
          break
      }
      timer = setTimeout(() => void tick(), 1000)
    }
    timer = setTimeout(() => void tick(), 1000)

    return () => {
      pollingRef.current = false
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  return (
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      clickOverlayToClose
      overlayClassName="modal-overlay"
      panelClassName="modal"
    >
      <div className="weixin-qr-dialog">
        <h3>连接微信</h3>
        <p className="weixin-qr-hint">用手机微信「扫一扫」下方二维码并确认授权</p>
        <div className="weixin-qr-img">
          {qrImg ? (
            <img src={qrImg} alt="微信登录二维码" />
          ) : (
            <div className="weixin-qr-placeholder">…</div>
          )}
        </div>
        <p className="weixin-qr-status">{statusText}</p>
        <div className="weixin-qr-actions">
          {expired && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                refreshCountRef.current = 0
                pollingRef.current = true
                void begin()
              }}
            >
              刷新二维码
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </AnimatedOverlay>
  )
}
