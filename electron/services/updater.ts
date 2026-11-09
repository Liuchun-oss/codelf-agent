import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import electronLog from 'electron-log'
import { log } from '../logger'
import { APP_WEBSITE } from '@shared/appConfig'
import type { UpdateStatus, UpdateInfo, UpdateProgress } from '@shared/updateTypes'

// 官网下载页：未签名的 macOS 无法应用内更新，只能引导用户手动下载。
const DOWNLOAD_PAGE = APP_WEBSITE

// 仅 Windows 支持应用内静默下载安装。macOS 未做签名+公证，autoUpdater 会拒绝更新；
// Linux 既没有签名产物也没有 latest-linux.yml，一并改为查 GitHub Releases 后引导前往官网。
const CAN_AUTO_UPDATE = process.platform === 'win32'

// 与 electron-builder.yml 的 publish 配置保持一致。
const LATEST_RELEASE_API = 'https://api.github.com/repos/Liuchun-oss/codelf-agent/releases/latest'

let status: UpdateStatus = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  info: null,
  progress: null,
  error: null,
  canAutoUpdate: CAN_AUTO_UPDATE
}

let initialized = false

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:status', status)
  }
}

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch, currentVersion: app.getVersion(), canAutoUpdate: CAN_AUTO_UPDATE }
  broadcast()
}

function toUpdateInfo(raw: { version: string; releaseNotes?: unknown; releaseName?: unknown; releaseDate?: string }): UpdateInfo {
  const notes = typeof raw.releaseNotes === 'string' ? raw.releaseNotes : null
  return {
    version: raw.version,
    releaseNotes: notes,
    releaseName: typeof raw.releaseName === 'string' ? raw.releaseName : null,
    releaseDate: raw.releaseDate ?? null
  }
}

function wireEvents(): void {
  autoUpdater.on('checking-for-update', () => {
    setStatus({ phase: 'checking', error: null })
  })

  autoUpdater.on('update-available', (info) => {
    log('info', `发现新版本 ${info.version}`)
    setStatus({ phase: 'available', info: toUpdateInfo(info) })
    // Windows 自动下载；macOS 不下载，交由 UI 引导跳转官网。
    if (CAN_AUTO_UPDATE) {
      setStatus({ phase: 'downloading', progress: null })
      void autoUpdater.downloadUpdate().catch((err: unknown) => {
        setStatus({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
      })
    }
  })

  autoUpdater.on('update-not-available', (info) => {
    setStatus({ phase: 'not-available', info: toUpdateInfo(info) })
  })

  autoUpdater.on('download-progress', (p) => {
    const progress: UpdateProgress = {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    }
    setStatus({ phase: 'downloading', progress })
  })

  autoUpdater.on('update-downloaded', (info) => {
    log('info', `新版本 ${info.version} 已下载完成，等待安装`)
    setStatus({ phase: 'downloaded', info: toUpdateInfo(info), progress: null })
  })

  autoUpdater.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err)
    log('error', `更新失败: ${message}`)
    setStatus({ phase: 'error', error: message })
  })
}

export function initUpdater(): void {
  if (initialized) return
  initialized = true

  autoUpdater.logger = electronLog
  // 手动控制下载与安装时机，避免下完立刻强制重启打断用户。
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  electronLog.transports.file.level = 'info'

  // 开发环境（未打包）没有 latest.yml，强制指向配置以便本地联调，同时避免直接抛错。
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true
  }

  wireEvents()
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

/**
 * 检查更新。silent=true 为启动后的后台静默检查（不弹窗，仅在下载完成时提示）；
 * silent=false 为用户主动触发。二者主进程逻辑一致，弹窗时机由渲染层依据触发来源决定。
 */
export async function checkForUpdates(_silent = false): Promise<UpdateStatus> {
  if (!initialized) initUpdater()

  // 下载完成后不再重复检查，直接返回“待安装”状态。
  if (status.phase === 'downloaded') return status

  // 不支持应用内更新的平台走 GitHub Releases 比对，命中新版本后由 UI 引导去官网下载。
  if (!CAN_AUTO_UPDATE) {
    await checkLatestRelease()
    return status
  }

  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    setStatus({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
  }
  return status
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0)
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

// 非 Windows 平台的更新检查：只读 GitHub Releases 最新标签，不下载任何东西。
async function checkLatestRelease(): Promise<void> {
  setStatus({ phase: 'checking', error: null })
  try {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as {
      tag_name?: string
      name?: string
      body?: string
      published_at?: string
    }
    const latest = (data.tag_name ?? '').replace(/^v/i, '')
    if (!latest) throw new Error('响应中缺少版本号')
    if (compareVersions(latest, app.getVersion()) > 0) {
      setStatus({
        phase: 'available',
        info: {
          version: latest,
          releaseNotes: data.body ?? null,
          releaseName: data.name ?? null,
          releaseDate: data.published_at ?? null
        }
      })
      return
    }
    setStatus({ phase: 'not-available', info: null })
  } catch (err) {
    log('error', `检查更新失败: ${err instanceof Error ? err.message : String(err)}`)
    setStatus({ phase: 'error', error: '检查更新失败，请前往官网查看最新版本。' })
  }
}

/** macOS / Linux 或用户手动触发时，用系统浏览器打开官网下载页。 */
export function openDownloadPage(): void {
  void import('electron').then(({ shell }) => shell.openExternal(DOWNLOAD_PAGE))
}

/** 退出并安装已下载的更新（仅 Windows）。 */
export function quitAndInstall(): void {
  if (!CAN_AUTO_UPDATE || status.phase !== 'downloaded') return
  // 先放行窗口关闭拦截，否则 quitAndInstall 触发的退出会被 close 事件挡下，装不上。
  void import('../main/index').then(({ allowAppCloseForUpdate }) => {
    allowAppCloseForUpdate()
    // isSilent=false 显示安装进度；isForceRunAfter=true 安装后自动重启。
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
  })
}
