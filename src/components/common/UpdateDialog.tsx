import { useEffect } from 'react'
import AnimatedOverlay from '@/components/common/AnimatedOverlay'
import { useUpdateStore } from '@/stores/updateStore'
import { APP_NAME } from '@shared/appConfig'

function formatBytes(n: number): string {
  if (!n || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

type Info = import('@shared/updateTypes').UpdateInfo | null | undefined
type Progress = import('@shared/updateTypes').UpdateProgress | null | undefined
type Phase = import('@shared/updateTypes').UpdatePhase

function renderBody(
  phase: Phase,
  currentVersion: string,
  info: Info,
  progress: Progress,
  error: string | null | undefined,
  canAutoUpdate: boolean,
  fmt: (n: number) => string
): JSX.Element {
  const cur = <div className="update-line">当前版本：v{currentVersion}</div>
  if (phase === 'checking') return <>{cur}<div>正在检查更新…</div></>
  if (phase === 'not-available') return <>{cur}<div>已是最新版本。</div></>
  if (phase === 'error') return <>{cur}<div className="modal-error">检查更新失败：{error}</div></>
  if (phase === 'downloading') {
    const pct = progress ? Math.round(progress.percent) : 0
    return (
      <>
        {cur}
        <div className="update-line">正在下载 v{info?.version}…（{pct}%）</div>
        <div className="update-progress"><div className="update-progress-bar" style={{ width: `${pct}%` }} /></div>
        {progress && <div className="update-sub">{fmt(progress.transferred)} / {fmt(progress.total)}</div>}
      </>
    )
  }
  if (phase === 'downloaded') {
    return <>{cur}<div className="update-line">新版本 v{info?.version} 已下载完成，重启即可安装。</div>{renderNotes(info)}</>
  }
  if (phase === 'available') {
    const tip = canAutoUpdate ? '正在准备下载…' : '当前系统需前往官网手动下载安装。'
    return <>{cur}<div className="update-line">发现新版本 v{info?.version}。{tip}</div>{renderNotes(info)}</>
  }
  return <>{cur}<div>点击“检查更新”查看是否有新版本。</div></>
}

function renderNotes(info: Info): JSX.Element | null {
  if (!info?.releaseNotes) return null
  const text = info.releaseNotes.replace(/<[^>]+>/g, '').trim()
  if (!text) return null
  return <div className="update-notes">{text}</div>
}

function renderFooter(
  phase: Phase,
  canAutoUpdate: boolean,
  actions: { close: () => void; install: () => void; openDownloadPage: () => void; manual: boolean }
): JSX.Element {
  const { close, install, openDownloadPage } = actions
  if (phase === 'downloaded' && canAutoUpdate) {
    return (
      <>
        <button className="btn-secondary" onClick={close}>稍后</button>
        <button className="btn" onClick={install}>重启并安装</button>
      </>
    )
  }
  if (phase === 'available' && !canAutoUpdate) {
    return (
      <>
        <button className="btn-secondary" onClick={close}>关闭</button>
        <button className="btn" onClick={openDownloadPage}>前往官网下载</button>
      </>
    )
  }
  return <button className="btn" onClick={close}>关闭</button>
}

export default function UpdateDialog(): JSX.Element | null {
  const open = useUpdateStore((s) => s.dialogOpen)
  const status = useUpdateStore((s) => s.status)
  const manual = useUpdateStore((s) => s.manual)
  const close = useUpdateStore((s) => s.closeDialog)
  const install = useUpdateStore((s) => s.install)
  const openDownloadPage = useUpdateStore((s) => s.openDownloadPage)

  useEffect(() => {
    useUpdateStore.getState().init()
  }, [])

  if (!status) return null

  const { phase, currentVersion, info, progress, error, canAutoUpdate } = status

  return (
    <AnimatedOverlay
      open={open}
      onClose={close}
      clickOverlayToClose
      overlayClassName="modal-overlay"
      panelClassName="modal"
    >
      <div className="modal-title">{`${APP_NAME} 更新`}</div>
      <div className="modal-body">
        <div className="modal-message">
          {renderBody(phase, currentVersion, info, progress, error, canAutoUpdate, formatBytes)}
        </div>
      </div>
      <div className="modal-footer">
        {renderFooter(phase, canAutoUpdate, { close, install, openDownloadPage, manual })}
      </div>
    </AnimatedOverlay>
  )
}
