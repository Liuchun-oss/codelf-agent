// 系统托盘：微信通道连接时关闭窗口可「最小化到托盘」后台收消息。
// 托盘按需创建（首次最小化到托盘时），退出应用时销毁。

import { Tray, Menu, nativeImage } from 'electron'
import type { BrowserWindow } from 'electron'
import { APP_NAME } from '@shared/appConfig'

let tray: Tray | null = null

interface TrayDeps {
  getWindow: () => BrowserWindow | null
  iconPath?: string
  // 触发"真正退出"（走 before-quit 清理流程）。
  quit: () => void
}

function showMainWindow(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// 确保托盘存在；已存在则复用。返回当前 Tray。
export function ensureTray(deps: TrayDeps): Tray {
  if (tray && !tray.isDestroyed()) return tray

  const image = deps.iconPath
    ? nativeImage.createFromPath(deps.iconPath)
    : nativeImage.createEmpty()
  tray = new Tray(image)
  tray.setToolTip(APP_NAME)

  const menu = Menu.buildFromTemplate([
    { label: `显示 ${APP_NAME}`, click: () => showMainWindow(deps.getWindow) },
    { type: 'separator' },
    { label: '退出', click: () => deps.quit() }
  ])
  tray.setContextMenu(menu)

  // 单击/双击托盘图标恢复主窗口（Windows 习惯）。
  tray.on('click', () => showMainWindow(deps.getWindow))
  tray.on('double-click', () => showMainWindow(deps.getWindow))

  return tray
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}

export function hasTray(): boolean {
  return !!tray && !tray.isDestroyed()
}
