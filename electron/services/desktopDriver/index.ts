// 桌面控制驱动接口：按 process.platform 分发到 Windows / macOS 实现。
// 采用零原生模块路线——Windows 经 PowerShell + .NET UIAutomation，
// macOS 经 osascript / AX + screencapture。

export interface LaunchResult {
  processId: number
  processName: string
}

export interface WindowInfo {
  nativeHandle: string
  title: string
  processName: string
  processId: number
}

export interface UiNode {
  ref: string
  role: string
  name: string
  // 控件是否可点击/可调用。
  actionable: boolean
  // 是否可填写文本（有 ValuePattern/AXValue）。
  editable: boolean
  // 控件外接矩形，屏幕坐标（像素）。
  bounds?: { x: number; y: number; width: number; height: number }
  // 控件中心点，目标窗口「客户区相对坐标」（像素），可直接传给 DesktopMouse/DesktopDrag。
  center?: { x: number; y: number }
}

export interface SnapshotResult {
  nodes: UiNode[]
  truncated: boolean
}

export interface ScreenshotResult {
  buffer: Buffer
  mime: string
}

export interface DriverActionResult {
  ok: boolean
  message?: string
}

export type MouseButton = 'left' | 'right' | 'middle'

// 鼠标动作模式：
// - 'virtual' 经窗口消息注入，不移动真实光标，不打扰用户（部分应用可能不响应）；
// - 'real' 经系统级输入（会移动真实光标），兼容性最好；
// - 'auto' 等同 'virtual'：优先不打扰用户。消息注入对部分应用（Chromium/Electron、
//   DirectX 游戏、Raw Input 程序）无效，此类情况无法在驱动内自动感知，需显式改用 'real'。
export type MousePointerMode = 'virtual' | 'real' | 'auto'

// 坐标统一约定为「目标窗口客户区左上角为原点」的相对坐标（像素）。
export interface MouseClickOptions {
  x: number
  y: number
  button?: MouseButton
  doubleClick?: boolean
  mode?: MousePointerMode
}

export interface MouseMoveOptions {
  x: number
  y: number
  mode?: MousePointerMode
}

export interface MouseDragOptions {
  fromX: number
  fromY: number
  toX: number
  toY: number
  button?: MouseButton
  // 中间插值步数，越多越平滑（部分应用的拖拽识别需要中间移动事件）。
  steps?: number
  mode?: MousePointerMode
}

export interface MouseScrollOptions {
  x: number
  y: number
  // 垂直/水平滚动量，正数向下/向右，单位为「刻度」（一个刻度约等于 120 wheel delta）。
  deltaY?: number
  deltaX?: number
  mode?: MousePointerMode
}

// 平台权限缺失等可预期错误，用此类型携带引导文案。
export class DesktopDriverError extends Error {
  readonly guidance?: string
  constructor(message: string, guidance?: string) {
    super(message)
    this.name = 'DesktopDriverError'
    this.guidance = guidance
  }
}

export interface DesktopDriver {
  readonly platform: NodeJS.Platform
  launchApp(app: string, args?: string[]): Promise<LaunchResult>
  listWindows(): Promise<WindowInfo[]>
  // 按标题（子串）/进程名/原生句柄定位单个窗口。
  findWindow(query: {
    title?: string
    processName?: string
    nativeHandle?: string
  }): Promise<WindowInfo | null>
  snapshot(nativeHandle: string, maxNodes: number): Promise<SnapshotResult>
  click(nativeHandle: string, ref: string): Promise<DriverActionResult>
  type(nativeHandle: string, ref: string, text: string, submit: boolean): Promise<DriverActionResult>
  // 坐标级鼠标控制（相对目标窗口客户区）。虚拟模式尽量不打扰用户真实鼠标。
  mouseClick(nativeHandle: string, options: MouseClickOptions): Promise<DriverActionResult>
  mouseMove(nativeHandle: string, options: MouseMoveOptions): Promise<DriverActionResult>
  mouseDrag(nativeHandle: string, options: MouseDragOptions): Promise<DriverActionResult>
  mouseScroll(nativeHandle: string, options: MouseScrollOptions): Promise<DriverActionResult>
  screenshot(nativeHandle: string): Promise<ScreenshotResult>
  // 等待匹配窗口出现；返回命中窗口或在超时后返回 null。
  waitForWindow(
    query: { title?: string; processName?: string },
    timeoutMs: number
  ): Promise<WindowInfo | null>
  closeApp(target: { processId?: number; nativeHandle?: string }, force: boolean): Promise<DriverActionResult>
}

let cached: DesktopDriver | null = null

export async function getDesktopDriver(): Promise<DesktopDriver> {
  if (cached) return cached
  if (process.platform === 'win32') {
    const { WindowsDesktopDriver } = await import('./windows')
    cached = new WindowsDesktopDriver()
  } else if (process.platform === 'darwin') {
    const { MacosDesktopDriver } = await import('./macos')
    cached = new MacosDesktopDriver()
  } else {
    throw new DesktopDriverError(
      `当前平台 ${process.platform} 暂不支持桌面控制工具。`,
      '桌面控制目前仅支持 Windows 与 macOS。'
    )
  }
  return cached
}
