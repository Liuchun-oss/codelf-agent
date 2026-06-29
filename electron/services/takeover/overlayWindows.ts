// 接管模式的两个覆盖层窗口：
// - HUD 窗：屏幕角落的小悬浮窗，显示 agent 文本流、状态与「停止」按钮（可交互）。
// - 跑马灯窗：覆盖整个目标显示器的全屏透明窗，纯视觉流光边框，点击穿透不干扰操作。
// 二者均无边框、透明、置顶、跳过任务栏，随接管开始/结束创建与销毁。

import { BrowserWindow, screen } from 'electron'
import { join } from 'path'

let hudWindow: BrowserWindow | null = null
let marqueeWindow: BrowserWindow | null = null

// 解析覆盖层页面地址：dev 用 vite 开发服务器，prod 用打包后的 renderer 目录。
function overlayUrl(page: 'hud' | 'marquee'): { url?: string; file?: string } {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) return { url: `${rendererUrl}/overlay/${page}.html` }
  return { file: join(__dirname, `../renderer/overlay/${page}.html`) }
}

function loadOverlay(win: BrowserWindow, page: 'hud' | 'marquee'): void {
  const target = overlayUrl(page)
  if (target.url) void win.loadURL(target.url)
  else if (target.file) void win.loadFile(target.file)
}

// HUD 默认尺寸与边距（相对目标显示器工作区右下角）。高度会随内容自适应。
const HUD_WIDTH = 400
const HUD_HEIGHT = 150
const HUD_MARGIN = 24

// 创建两个覆盖层窗口。displayId 指定目标显示器，不传则用鼠标所在显示器。
export function createOverlays(preloadPath: string, displayId?: number): void {
  destroyOverlays()
  const display =
    (displayId != null && screen.getAllDisplays().find((d) => d.id === displayId)) ||
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = display.workArea
  const full = display.bounds

  // 跑马灯：覆盖整个显示器 bounds，点击穿透。
  marqueeWindow = new BrowserWindow({
    x: full.x,
    y: full.y,
    width: full.width,
    height: full.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    show: false,
    webPreferences: { preload: preloadPath, sandbox: false, contextIsolation: true, nodeIntegration: false }
  })
  marqueeWindow.setAlwaysOnTop(true, 'screen-saver')
  marqueeWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 全窗点击穿透，鼠标事件转发给下层真实窗口，纯视觉不挡操作。
  marqueeWindow.setIgnoreMouseEvents(true, { forward: true })
  loadOverlay(marqueeWindow, 'marquee')
  marqueeWindow.once('ready-to-show', () => marqueeWindow?.showInactive())

  // HUD：右下角小窗，可交互（停止按钮）。
  hudWindow = new BrowserWindow({
    x: wa.x + wa.width - HUD_WIDTH - HUD_MARGIN,
    y: wa.y + wa.height - HUD_HEIGHT - HUD_MARGIN,
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    show: false,
    webPreferences: { preload: preloadPath, sandbox: false, contextIsolation: true, nodeIntegration: false }
  })
  hudWindow.setAlwaysOnTop(true, 'screen-saver')
  hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  loadOverlay(hudWindow, 'hud')
  hudWindow.once('ready-to-show', () => hudWindow?.showInactive())
}

// 向 HUD 窗推送一条消息（agent 事件 / 状态变更）。
export function sendToHud(channel: string, payload: unknown): void {
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.webContents.send(channel, payload)
}

// 按内容高度自适应 HUD 窗口（保持宽度与右下角锚定）。在 min/max 之间钳制。
export function resizeHud(contentHeight: number): void {
  if (!hudWindow || hudWindow.isDestroyed()) return
  const h = Math.max(96, Math.min(Math.round(contentHeight), 460))
  const [w] = hudWindow.getSize()
  const [x, y] = hudWindow.getPosition()
  const oldH = hudWindow.getSize()[1]
  // 维持窗口底边位置不变（向上生长），避免底部超出工作区。
  const newY = y + (oldH - h)
  hudWindow.setBounds({ x, y: newY, width: w, height: h })
}

export function destroyOverlays(): void {
  for (const w of [hudWindow, marqueeWindow]) {
    if (w && !w.isDestroyed()) w.destroy()
  }
  hudWindow = null
  marqueeWindow = null
}

export function hasOverlays(): boolean {
  return !!hudWindow && !hudWindow.isDestroyed()
}
