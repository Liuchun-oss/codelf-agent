import { app, BrowserWindow, shell, ipcMain, nativeImage, protocol, dialog } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { registerFileIpc } from '../ipc/file'
import { registerTerminalIpc } from '../ipc/terminal'
import { registerInlineRunIpc } from '../ipc/inlineRun'
import { registerAgentModule } from '../agent'
import { registerLspIpc } from '../ipc/lsp'
import { registerWatcherIpc } from '../ipc/watcher'
import { registerSearchIpc } from '../ipc/search'
import { registerSemanticIpc } from '../ipc/semantic'
import { registerKnowledgeIpc } from '../ipc/knowledge'
import { registerGitIpc } from '../ipc/git'
import { registerPythonIpc } from '../ipc/pythonEnv'
import { registerEnvIpc } from '../ipc/env'
import { buildAppMenu } from '../menu'
import { registerWindowIpc } from '../ipc/window'
import { registerAppIpc } from '../ipc/app'
import { ensureTray, destroyTray } from './tray'
import { registerChannelsIpc } from '../ipc/channels'
import { registerScheduleIpc } from '../ipc/schedule'
import { registerRoomIpc } from '../ipc/room'
import { initChannels } from '../channels/index'
import { initLogging } from '../logger'
import { setLocalWriteTarget } from '../services/localWriteRegistry'
import { resumeVideoTasksOnStartup } from '../services/videoTaskQueue'
import { resumeSchedulesOnStartup } from '../services/scheduleQueue'
import { resumeRoomsOnStartup } from '../services/roomStore'
import { BROWSER_PREVIEW_SCHEME, readBrowserPreview } from '../services/browserPreviewImage'
import { ARTIFACT_FILE_SCHEME, readArtifactFile } from '../services/artifactFileServer'
import { cleanupRendererBoundResources } from '../services/appLifecycle'
import { migrateUserDataDir } from '../services/brandMigration'
import { APP_NAME } from '@shared/appConfig'

protocol.registerSchemesAsPrivileged([
  {
    scheme: BROWSER_PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      bypassCSP: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  },
  {
    scheme: ARTIFACT_FILE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

const useCustomTitleBar = process.platform === 'win32'

let mainWindow: BrowserWindow | null = null

let allowClose = false
let isQuitting = false

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

function windowStateFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): WindowState {
  try {
    const raw = readFileSync(windowStateFile(), 'utf-8')
    const s = JSON.parse(raw) as WindowState
    if (typeof s.width === 'number' && typeof s.height === 'number') return s
  } catch {
    /* 读取窗口状态失败则用默认尺寸 */
  }
  return { width: 1400, height: 900 }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const maximized = win.isMaximized()
    const bounds = win.getNormalBounds()
    const state: WindowState = { ...bounds, maximized }
    writeFileSync(windowStateFile(), JSON.stringify(state))
  } catch {
    /* 保存窗口状态失败不致命 */
  }
}

function resolveAppIconPath(): string | undefined {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'icon.ico'), join(process.resourcesPath, 'icon.png')]
    : [
        join(__dirname, '../../resources/icon.ico'),
        join(__dirname, '../../resources/icon.png')
      ]
  return candidates.find((p) => existsSync(p))
}

function createWindow(): void {
  const saved = loadWindowState()
  const iconPath = resolveAppIconPath()

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 1024,
    minHeight: 640,
    title: APP_NAME,
    backgroundColor: '#1e1e1e',
    show: false,
    frame: !useCustomTitleBar,
    autoHideMenuBar: useCustomTitleBar,
    ...(iconPath ? { icon: nativeImage.createFromPath(iconPath) } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  if (saved.maximized) mainWindow.maximize()

  if (useCustomTitleBar) {
    mainWindow.setMenuBarVisibility(false)
  }
  const notifyMaximized = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', notifyMaximized)
  mainWindow.on('unmaximize', notifyMaximized)

  
  setLocalWriteTarget(mainWindow.webContents)
  mainWindow.on('closed', () => setLocalWriteTarget(null))

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    // 恢复上次未完成的视频生成任务，继续后台轮询。
    resumeVideoTasksOnStartup()
    // 恢复定时任务调度：清残留 running、补跑错过的任务、重算下次执行并启动循环。
    resumeSchedulesOnStartup()
    // 加载群聊定义（懒加载引擎；半途崩溃的循环不自动续跑，§6.8）。
    resumeRoomsOnStartup()
  })

  
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key?.toLowerCase()
    // 屏蔽 F12 / Ctrl+Shift+I 打开调试窗口
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      event.preventDefault()
    }
  })

  
  let stateTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSave = (): void => {
    if (stateTimer) clearTimeout(stateTimer)
    stateTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow)
    }, 400)
  }
  mainWindow.on('resize', scheduleSave)
  mainWindow.on('move', scheduleSave)

  
  mainWindow.on('close', (e) => {
    if (allowClose) {
      if (mainWindow) saveWindowState(mainWindow)
      return
    }
    e.preventDefault()
    mainWindow?.webContents.send('app:queryClose')
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 内置浏览器 <webview> 安全加固：剥离 preload/nodeIntegration，
  // 并把 webview 内部的弹窗（window.open / target=_blank）导航到内嵌新标签或系统浏览器。
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
  })
  mainWindow.webContents.on('did-attach-webview', (_event, wc) => {
    wc.setWindowOpenHandler((details) => {
      mainWindow?.webContents.send('browser:openUrl', details.url)
      return { action: 'deny' }
    })
  })

  
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

}

// 单实例锁：保证同一时间只有一个 codelf 在运行。
// 抢锁失败说明已有实例在跑，弹窗提示后立即退出当前进程。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  dialog.showErrorBox(APP_NAME, `${APP_NAME} 已在运行中，请勿重复运行。`)
  app.quit()
} else {
  // 已存在实例时，新启动会触发此事件：把已有窗口唤到前台，避免“看起来没反应”。
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    }
  })
  bootstrap()
}

function bootstrap(): void {
app.whenReady().then(() => {
  migrateUserDataDir()

  protocol.handle(BROWSER_PREVIEW_SCHEME, async (request) => {
    const id = decodeURIComponent(request.url.slice(`${BROWSER_PREVIEW_SCHEME}://`.length))
    const preview = await readBrowserPreview(id)
    if (!preview) return new Response('Not found', { status: 404 })
    return new Response(new Uint8Array(preview.data), { headers: { 'Content-Type': preview.mime } })
  })

  protocol.handle(ARTIFACT_FILE_SCHEME, async (request) => {
    const file = await readArtifactFile(request.url)
    if (!file) return new Response('Not found', { status: 404 })
    return new Response(new Uint8Array(file.data), { headers: { 'Content-Type': file.mime } })
  })

  initLogging()

  
  ipcMain.on('app:confirmClose', () => {
    allowClose = true
    mainWindow?.close()
  })

  // 微信连接时用户选择「最小化到托盘」：隐藏窗口（不退出），保证后台继续收消息。
  ipcMain.on('app:minimizeToTray', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    ensureTray({
      getWindow: () => mainWindow,
      iconPath: resolveAppIconPath(),
      quit: () => {
        allowClose = true
        mainWindow?.close()
      }
    })
    mainWindow.hide()
  })

  registerFileIpc()
  registerTerminalIpc()
  registerInlineRunIpc()
  registerAgentModule()
  registerLspIpc()
  registerWatcherIpc()
  registerSearchIpc()
  registerSemanticIpc()
  registerKnowledgeIpc()
  registerGitIpc()
  registerPythonIpc()
  registerEnvIpc()
  registerWindowIpc()
  registerAppIpc()
  registerChannelsIpc()
  registerScheduleIpc()
  registerRoomIpc()

  buildAppMenu()
  createWindow()

  // 通讯通道（微信）：按配置自动启动长轮询（已启用且已登录时）。
  void initChannels()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (e) => {
  if (isQuitting) return
  e.preventDefault()
  isQuitting = true
  destroyTray()
  void cleanupRendererBoundResources().finally(() => {
    void import('../services/roomStore').then((m) => m.flushCursorPersist()).catch(() => {})
    void import('../channels/manager').then((m) => m.getChannelManager().stopAll()).catch(() => {})
    void import('../services/semantic/embedService').then((m) => m.shutdownEmbedWorker()).catch(() => {})
    void import('../services/knowledge/embedService').then((m) => m.shutdownKnowledgeEmbedWorker()).catch(() => {})
    void import('../services/knowledge/store').then((m) => m.closeStore()).catch(() => {})
    app.quit()
  })
})
}
