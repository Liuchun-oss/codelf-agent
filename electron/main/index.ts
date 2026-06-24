import { app, BrowserWindow, shell, ipcMain, nativeImage, protocol } from 'electron'
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
import { initLogging } from '../logger'
import { setLocalWriteTarget } from '../services/localWriteRegistry'
import { resumeVideoTasksOnStartup } from '../services/videoTaskQueue'
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
  })

  
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key?.toLowerCase()
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      mainWindow?.webContents.toggleDevTools()
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

  buildAppMenu()
  createWindow()

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
  void cleanupRendererBoundResources().finally(() => {
    void import('../services/semantic/embedService').then((m) => m.shutdownEmbedWorker()).catch(() => {})
    void import('../services/knowledge/embedService').then((m) => m.shutdownKnowledgeEmbedWorker()).catch(() => {})
    void import('../services/knowledge/store').then((m) => m.closeStore()).catch(() => {})
    app.quit()
  })
})
