import { ipcMain, BrowserWindow, app } from 'electron'
import { cleanupRendererBoundResources } from '../services/appLifecycle'
import {
  checkForUpdates,
  getUpdateStatus,
  openDownloadPage,
  quitAndInstall
} from '../services/updater'

export function registerAppIpc(): void {
  ipcMain.on('app:quit', () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    win?.close()
  })

  ipcMain.on('app:reload', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    void cleanupRendererBoundResources().finally(() => win?.webContents.reload())
  })

  ipcMain.handle('app:zoomIn', (event) => {
    const wc = BrowserWindow.fromWebContents(event.sender)?.webContents
    if (wc) wc.setZoomLevel(wc.getZoomLevel() + 1)
  })

  ipcMain.handle('app:zoomOut', (event) => {
    const wc = BrowserWindow.fromWebContents(event.sender)?.webContents
    if (wc) wc.setZoomLevel(wc.getZoomLevel() - 1)
  })

  ipcMain.handle('app:resetZoom', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.webContents.setZoomLevel(0)
  })

  ipcMain.handle('app:toggleFullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.setFullScreen(!win.isFullScreen())
  })

  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('update:status', () => getUpdateStatus())
  ipcMain.handle('update:check', () => checkForUpdates(false))
  ipcMain.handle('update:openDownloadPage', () => openDownloadPage())
  ipcMain.handle('update:install', () => quitAndInstall())
}
