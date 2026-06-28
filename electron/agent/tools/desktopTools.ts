import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import {
  ensureDesktopSession,
  getDesktopSession,
  getWindow,
  registerWindow,
  setWindowScreenshotScale,
  trackLaunchedPid
} from '../../services/desktopSession'
import { getDesktopDriver, DesktopDriverError, type WindowInfo } from '../../services/desktopDriver'
import { storeBrowserPreview, browserPreviewUrl } from '../../services/browserPreviewImage'
import { BROWSER_OPEN_NAME } from '../prompts/tools/browser'
import {
  DESKTOP_LAUNCH_APP_NAME,
  DESKTOP_LAUNCH_APP_DESCRIPTION,
  DESKTOP_LIST_WINDOWS_NAME,
  DESKTOP_LIST_WINDOWS_DESCRIPTION,
  DESKTOP_GET_WINDOW_NAME,
  DESKTOP_GET_WINDOW_DESCRIPTION,
  DESKTOP_SNAPSHOT_NAME,
  DESKTOP_SNAPSHOT_DESCRIPTION,
  DESKTOP_CLICK_NAME,
  DESKTOP_CLICK_DESCRIPTION,
  DESKTOP_TYPE_NAME,
  DESKTOP_TYPE_DESCRIPTION,
  DESKTOP_MOUSE_NAME,
  DESKTOP_MOUSE_DESCRIPTION,
  DESKTOP_MOUSE_MOVE_NAME,
  DESKTOP_MOUSE_MOVE_DESCRIPTION,
  DESKTOP_DRAG_NAME,
  DESKTOP_DRAG_DESCRIPTION,
  DESKTOP_SCROLL_NAME,
  DESKTOP_SCROLL_DESCRIPTION,
  DESKTOP_KEY_NAME,
  DESKTOP_KEY_DESCRIPTION,
  DESKTOP_SCREENSHOT_NAME,
  DESKTOP_SCREENSHOT_DESCRIPTION,
  DESKTOP_WAIT_FOR_NAME,
  DESKTOP_WAIT_FOR_DESCRIPTION,
  DESKTOP_HANDOFF_NAME,
  DESKTOP_HANDOFF_DESCRIPTION,
  DESKTOP_CLOSE_APP_NAME,
  DESKTOP_CLOSE_APP_DESCRIPTION
} from '../prompts/tools/desktop'

const MAX_SNAPSHOT_NODES = 200
const MAX_SCREENSHOT_BYTES = 5_000_000
const DEFAULT_WAIT_MS = 15_000
// 单条上下文字段（选中文本/文档正文）回灌给模型时的字符上限，避免长文档撑爆上下文。
const MAX_CONTEXT_FIELD_CHARS = 2000

// 截断过长的上下文字段并标注省略量。
function truncateField(text: string): string {
  const t = text.replace(/\r\n/g, '\n')
  if (t.length <= MAX_CONTEXT_FIELD_CHARS) return t
  return `${t.slice(0, MAX_CONTEXT_FIELD_CHARS)}…（已截断，共 ${t.length} 字）`
}
// 截图发给模型前的默认最长边上限（像素），压低视觉 token 成本。
const DEFAULT_SCREENSHOT_MAX_DIM = 1280

// 坐标空间：'image' 表示坐标取自最近一次（可能被缩小的）截图像素，需按缩放系数还原；
// 'client' 表示已是窗口客户区真实像素，直接使用。
const coordinateSpaceSchema = z
  .enum(['image', 'client'])
  .optional()
  .describe('Coordinate space of x/y: "image" (default, pixels off the latest DesktopScreenshot, auto-rescaled) or "client" (true client-area pixels)')

// 把输入坐标按坐标空间换算成客户区真实像素。
function toClientCoord(
  sessionId: string,
  windowId: string,
  value: number,
  space: 'image' | 'client' | undefined
): number {
  if (space === 'client') return value
  const scale = getWindow(sessionId, windowId)?.lastScreenshotScale
  // 未截图或缩放系数无效时按 1:1 处理（等价于客户区坐标）。
  if (!scale || !Number.isFinite(scale) || scale <= 0) return value
  return value / scale
}

// 统一把驱动错误转为工具结果（含权限引导文案）。
function driverError(e: unknown): ToolResult {
  if (e instanceof DesktopDriverError) {
    return { content: `${e.message}${e.guidance ? `\n\n${e.guidance}` : ''}`, isError: true }
  }
  return { content: e instanceof Error ? e.message : '桌面操作失败', isError: true }
}

function requireWindow(sessionId: string, windowId: string) {
  const session = getDesktopSession(sessionId)
  if (!session || session.status !== 'open') {
    return { error: { content: `桌面会话不存在或已关闭：${sessionId}`, isError: true } as ToolResult }
  }
  const win = getWindow(sessionId, windowId)
  if (!win) {
    return {
      error: {
        content: `未找到 windowId：${windowId}。请先调用 ${DESKTOP_GET_WINDOW_NAME}。`,
        isError: true
      } as ToolResult
    }
  }
  return { win }
}

function describeWindow(w: WindowInfo): string {
  return `${w.processName} (pid ${w.processId}) — "${w.title}" [handle ${w.nativeHandle}]`
}

// 已知基于 Chromium/Electron 或强 Raw Input 的进程：虚拟消息注入（PostMessage）对它们
// 普遍无效，需要走真实输入或浏览器工具。进程名为不含扩展名的小写匹配。
const CHROMIUM_PROCESS_HINTS = [
  'chrome', 'msedge', 'brave', 'opera', 'vivaldi', 'chromium',
  'electron', 'code', 'slack', 'discord', 'spotify', 'whatsapp',
  'notion', 'figma', 'postman', 'obsidian', 'feishu', 'lark',
  'dingtalk', 'wxwork', 'qqnt'
]

type WindowKind = 'browser' | 'electron' | 'native'

function classifyWindow(w: WindowInfo): WindowKind {
  const name = w.processName.toLowerCase().replace(/\.exe$/, '')
  const isBrowser = ['chrome', 'msedge', 'brave', 'opera', 'vivaldi', 'chromium'].some((h) => name === h || name.includes(h))
  if (isBrowser) return 'browser'
  if (CHROMIUM_PROCESS_HINTS.some((h) => name === h || name.includes(h))) return 'electron'
  return 'native'
}

// 针对 Chromium/Electron 系窗口，给模型的分流建议文案（advisory，不改变行为）。
function routingAdvisory(w: WindowInfo): string {
  const kind = classifyWindow(w)
  if (kind === 'browser') {
    return `\n\n提示：该窗口是 Chromium 系浏览器（${w.processName}）。虚拟消息注入对其通常无效。若目标是网页内容，请改用 ${BROWSER_OPEN_NAME} 等 Browser* 工具自动化网页；若确需直接操作此窗口，对鼠标/按键工具显式传 mode:"real"。`
  }
  if (kind === 'electron') {
    return `\n\n提示：该窗口疑似 Electron/Chromium 应用（${w.processName}），多走 Raw Input。虚拟点击可能无效——优先用 DesktopSnapshot 的无障碍控件 ref（DesktopClick/DesktopType），坐标级操作请显式传 mode:"real"。`
  }
  return ''
}

// [LAUNCH]
const launchSchema = z.object({
  app: z.string().min(1).describe('Executable name, path, or app name to launch'),
  args: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .describe('Extra command-line arguments (array; a single string or empty string is also accepted)'),
  sessionId: z.string().optional().describe('Existing desktop session id; omit to create one')
})
type LaunchInput = z.infer<typeof launchSchema>

export const desktopLaunchAppTool: Tool<LaunchInput> = {
  name: DESKTOP_LAUNCH_APP_NAME,
  description: DESKTOP_LAUNCH_APP_DESCRIPTION,
  schema: launchSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const driver = await getDesktopDriver()
      const session = input.sessionId
        ? getDesktopSession(input.sessionId) ?? ensureDesktopSession(ctx.sessionId)
        : ensureDesktopSession(ctx.sessionId)
      const rawArgs = Array.isArray(input.args) ? input.args : input.args ? [input.args] : []
      const args = rawArgs.map((s) => s.trim()).filter(Boolean)
      const result = await driver.launchApp(input.app, args)
      if (result.processId) trackLaunchedPid(session.id, result.processId)
      return {
        content: `Launched ${result.processName} (pid ${result.processId}).\nsessionId: ${session.id}\n下一步可调用 ${DESKTOP_WAIT_FOR_NAME} 或 ${DESKTOP_GET_WINDOW_NAME} 定位窗口。`
      }
    } catch (e) {
      return driverError(e)
    }
  }
}
// [LIST]
const listSchema = z.object({
  sessionId: z.string().optional().describe('Existing desktop session id; omit to create one')
})
type ListInput = z.infer<typeof listSchema>

export const desktopListWindowsTool: Tool<ListInput> = {
  name: DESKTOP_LIST_WINDOWS_NAME,
  description: DESKTOP_LIST_WINDOWS_DESCRIPTION,
  schema: listSchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const driver = await getDesktopDriver()
      const session = input.sessionId
        ? getDesktopSession(input.sessionId) ?? ensureDesktopSession(ctx.sessionId)
        : ensureDesktopSession(ctx.sessionId)
      const windows = await driver.listWindows()
      const body = windows.length
        ? windows.map((w, i) => `[${i}] ${describeWindow(w)}`).join('\n')
        : '(无可见窗口)'
      return { content: `sessionId: ${session.id}\nWindows:\n${body}` }
    } catch (e) {
      return driverError(e)
    }
  }
}
// [GETWINDOW]
const getWindowSchema = z
  .object({
    sessionId: z.string().optional().describe('Existing desktop session id; omit to create one'),
    title: z.string().optional().describe('Window title substring (case-insensitive)'),
    processName: z.string().optional().describe('Owning process name'),
    nativeHandle: z.string().optional().describe('Native window handle from DesktopListWindows')
  })
  .refine((v) => v.title || v.processName || v.nativeHandle, {
    message: 'Provide at least one of title, processName, or nativeHandle'
  })
type GetWindowInput = z.infer<typeof getWindowSchema>

export const desktopGetWindowTool: Tool<GetWindowInput> = {
  name: DESKTOP_GET_WINDOW_NAME,
  description: DESKTOP_GET_WINDOW_DESCRIPTION,
  schema: getWindowSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const driver = await getDesktopDriver()
      const session = input.sessionId
        ? getDesktopSession(input.sessionId) ?? ensureDesktopSession(ctx.sessionId)
        : ensureDesktopSession(ctx.sessionId)
      const win = await driver.findWindow({
        title: input.title,
        processName: input.processName,
        nativeHandle: input.nativeHandle
      })
      if (!win) return { content: '未找到匹配的窗口。可先用 DesktopListWindows 查看现有窗口。', isError: true }
      const ref = registerWindow(session.id, win)
      if (!ref) return { content: '会话已关闭，无法登记窗口', isError: true }
      return {
        content: `windowId: ${ref.windowId}\nsessionId: ${session.id}\n${describeWindow(win)}${routingAdvisory(win)}`
      }
    } catch (e) {
      return driverError(e)
    }
  }
}
// [SNAPSHOT]
const windowActionSchema = z.object({
  sessionId: z.string().min(1).describe('Desktop session id'),
  windowId: z.string().min(1).describe('Window id from DesktopGetWindow')
})

export const desktopSnapshotTool: Tool<z.infer<typeof windowActionSchema>> = {
  name: DESKTOP_SNAPSHOT_NAME,
  description: DESKTOP_SNAPSHOT_DESCRIPTION,
  schema: windowActionSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const { win, error } = requireWindow(input.sessionId, input.windowId)
    if (error) return error
    try {
      const driver = await getDesktopDriver()
      const snap = await driver.snapshot(win.nativeHandle, MAX_SNAPSHOT_NODES)
      const lines = snap.nodes.map((n) => {
        const flags = [
          n.actionable ? 'actionable' : '',
          n.editable ? 'editable' : '',
          n.enabled === false ? 'disabled' : ''
        ]
          .filter(Boolean)
          .join(',')
        const name = n.name ? ` "${n.name}"` : ''
        const at = n.center ? ` @(${n.center.x},${n.center.y})` : ''
        // 按嵌套深度缩进，呈现父子结构（depth 缺省时不缩进）。上限 12 级防止过宽。
        const indent = '  '.repeat(Math.min(n.depth ?? 0, 12))
        return `${indent}${n.role}${name}${flags ? ` (${flags})` : ''}${at} [ref=${n.ref}]`
      })
      // 高频上下文优先展示，便于模型快速判断当前焦点/选区/正文，无需在节点列表里翻找。
      const ctx: string[] = []
      if (snap.focusedElement) ctx.push(`Focused: ${snap.focusedElement}`)
      if (snap.selectedText) ctx.push(`Selected text: ${truncateField(snap.selectedText)}`)
      if (snap.documentText) ctx.push(`Document text: ${truncateField(snap.documentText)}`)
      const ctxBlock = ctx.length ? `${ctx.join('\n')}\n\n` : ''
      if (snap.nodes.length === 0) {
        return { content: ctxBlock ? `${ctxBlock}(未发现可交互控件)` : '(未发现可交互控件)' }
      }
      return {
        content: `${ctxBlock}UI components (use the bare ref like "n12" with DesktopClick/DesktopType; @(x,y) is the client-area center you can pass to DesktopMouse/DesktopDrag):\n${lines.join('\n')}`,
        truncated: snap.truncated
      }
    } catch (e) {
      return driverError(e)
    }
  }
}
// [CLICK]
const clickSchema = z.object({
  sessionId: z.string().min(1).describe('Desktop session id'),
  windowId: z.string().min(1).describe('Window id from DesktopGetWindow'),
  ref: z.string().min(1).describe('Element ref from DesktopSnapshot (e.g. "n12")')
})
type ClickInput = z.infer<typeof clickSchema>

export const desktopClickTool: Tool<ClickInput> = {
  name: DESKTOP_CLICK_NAME,
  description: DESKTOP_CLICK_DESCRIPTION,
  schema: clickSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const { win, error } = requireWindow(input.sessionId, input.windowId)
    if (error) return error
    try {
      const driver = await getDesktopDriver()
      const res = await driver.click(win.nativeHandle, input.ref)
      if (!res.ok) return { content: res.message ?? '点击失败', isError: true }
      return { content: `Clicked ${input.ref}.${res.message ? ` (${res.message})` : ''}` }
    } catch (e) {
      return driverError(e)
    }
  }
}
// [TYPE]
const typeSchema = z.object({
  sessionId: z.string().min(1).describe('Desktop session id'),
  windowId: z.string().min(1).describe('Window id from DesktopGetWindow'),
  ref: z.string().min(1).describe('Element ref from DesktopSnapshot'),
  text: z.string().describe('Text to fill into the control'),
  submit: z.boolean().optional().describe('Press Enter after typing')
})
type TypeInput = z.infer<typeof typeSchema>

export const desktopTypeTool: Tool<TypeInput> = {
  name: DESKTOP_TYPE_NAME,
  description: DESKTOP_TYPE_DESCRIPTION,
  schema: typeSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const { win, error } = requireWindow(input.sessionId, input.windowId)
    if (error) return error
    try {
      const driver = await getDesktopDriver()
      const res = await driver.type(win.nativeHandle, input.ref, input.text, input.submit ?? false)
      if (!res.ok) return { content: res.message ?? '输入失败', isError: true }
      return { content: `Typed into ${input.ref}${input.submit ? ' and submitted' : ''}.` }
    } catch (e) {
      return driverError(e)
    }
  }
}
// [MOUSE]
const pointerModeSchema = z
  .enum(['virtual', 'real', 'auto'])
  .optional()
  .describe('virtual=inject window messages without moving the real cursor (default); real=move the actual cursor; auto')
const buttonSchema = z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)')

const mouseSchema = z.object({
  sessionId: z.string().min(1).describe('Desktop session id'),
  windowId: z.string().min(1).describe('Window id from DesktopGetWindow'),
  x: z.number().describe('X pixels (image-space by default; see coordinateSpace)'),
  y: z.number().describe('Y pixels (image-space by default; see coordinateSpace)'),
  coordinateSpace: coordinateSpaceSchema,
  button: buttonSchema,
  doubleClick: z.boolean().optional().describe('Perform a double click'),
  mode: pointerModeSchema
})
type MouseInput = z.infer<typeof mouseSchema>

export const desktopMouseTool: Tool<MouseInput> = {
  name: DESKTOP_MOUSE_NAME,
  description: DESKTOP_MOUSE_DESCRIPTION,
  schema: mouseSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const { win, error } = requireWindow(input.sessionId, input.windowId)
    if (error) return error
    try {
      const driver = await getDesktopDriver()
      const x = toClientCoord(input.sessionId, input.windowId, input.x, input.coordinateSpace)
      const y = toClientCoord(input.sessionId, input.windowId, input.y, input.coordinateSpace)
      const res = await driver.mouseClick(win.nativeHandle, {
        x,
        y,
        button: input.button,
        doubleClick: input.doubleClick,
        mode: input.mode
      })
      if (!res.ok) return { content: res.message ?? '点击失败', isError: true }
      const how = (input.mode ?? 'auto') === 'real' ? '真实光标' : '虚拟消息'
      const retryHint =
        (input.mode ?? 'auto') !== 'real' && classifyWindow(win) !== 'native'
          ? ` 若无效，该窗口（${win.processName}）疑似 Chromium/Electron，请重试并传 mode:"real"。`
          : ''
      return { content: `Clicked at client (${Math.round(x)}, ${Math.round(y)}) with ${input.button ?? 'left'} button [${how}].${retryHint}` }
    } catch (e) {
      return driverError(e)
    }
  }
}

const mouseMoveSchema = z.object({
  sessionId: z.string().min(1).describe('Desktop session id'),
  windowId: z.string().min(1).describe('Window id from DesktopGetWindow'),
  x: z.number().describe('X pixels (image-space by default; see coordinateSpace)'),
  y: z.number().describe('Y pixels (image-space by default; see coordinateSpace)'),
  coordinateSpace: coordinateSpaceSchema,
  mode: pointerModeSchema
})
type MouseMoveInput = z.infer<typeof mouseMoveSchema>

export const desktopMouseMoveTool: Tool<MouseMoveInput> = {
  name: DESKTOP_MOUSE_MOVE_NAME,
  description: DESKTOP_MOUSE_MOVE_DESCRIPTION,
  schema: mouseMoveSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const { win, error } = requireWindow(input.sessionId, input.windowId)
    if (error) return error
    try {
      const driver = await getDesktopDriver()
      const x = toClientCoord(input.sessionId, input.windowId, input.x, input.coordinateSpace)
      const y = toClientCoord(input.sessionId, input.windowId, input.y, input.coordinateSpace)
      const res = await driver.mouseMove(win.nativeHandle, { x, y, mode: input.mode })
      if (!res.ok) return { content: res.message ?? '移动失败', isError: true }
      return { content: `Moved pointer to client (${Math.round(x)}, ${Math.round(y)}).` }
    } catch (e) {
      return driverError(e)
    }
  }
}

const dragSchema = z.object({
  sessionId: z.string().min(1).describe('Desktop session id'),
  windowId: z.string().min(1).describe('Window id from DesktopGetWindow'),
  fromX: z.number().describe('Start X pixels (image-space by default)'),
  fromY: z.number().describe('Start Y pixels (image-space by default)'),
  toX: z.number().describe('End X pixels (image-space by default)'),
  toY: z.number().describe('End Y pixels (image-space by default)'),
  coordinateSpace: coordinateSpaceSchema,
  button: buttonSchema,
  steps: z.number().int().min(2).max(200).optional().describe('Intermediate move steps (default 20)'),
  mode: pointerModeSchema
})
type DragInput = z.infer<typeof dragSchema>

export const desktopDragTool: Tool<DragInput> = {
  name: DESKTOP_DRAG_NAME,
  description: DESKTOP_DRAG_DESCRIPTION,
  schema: dragSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const { win, error } = requireWindow(input.sessionId, input.windowId)
    if (error) return error
    try {
      const driver = await getDesktopDriver()
      const sp = input.coordinateSpace
      const fromX = toClientCoord(input.sessionId, input.windowId, input.fromX, sp)
      const fromY = toClientCoord(input.sessionId, input.windowId, input.fromY, sp)
      const toX = toClientCoord(input.sessionId, input.windowId, input.toX, sp)
      const toY = toClientCoord(input.sessionId, input.windowId, input.toY, sp)
      const res = await driver.mouseDrag(win.nativeHandle, {
        fromX,
        fromY,
        toX,
        toY,
        button: input.button,
        steps: input.steps,
        mode: input.mode
      })
      if (!res.ok) return { content: res.message ?? '拖拽失败', isError: true }
      return {
        content: `Dragged from client (${Math.round(fromX)}, ${Math.round(fromY)}) to (${Math.round(toX)}, ${Math.round(toY)}) with ${input.button ?? 'left'} button.`
      }
    } catch (e) {
      return driverError(e)
    }
  }
}

const scrollSchema = z
  .object({
    sessionId: z.string().min(1).describe('Desktop session id'),
    windowId: z.string().min(1).describe('Window id from DesktopGetWindow'),
    x: z.number().describe('X pixels to scroll over (image-space by default)'),
    y: z.number().describe('Y pixels to scroll over (image-space by default)'),
    coordinateSpace: coordinateSpaceSchema,
    deltaY: z.number().optional().describe('Vertical ticks; positive scrolls down'),
    deltaX: z.number().optional().describe('Horizontal ticks; positive scrolls right'),
    mode: pointerModeSchema
  })
  .refine((v) => (v.deltaY ?? 0) !== 0 || (v.deltaX ?? 0) !== 0, {
    message: 'Provide a non-zero deltaY or deltaX'
  })
type ScrollInput = z.infer<typeof scrollSchema>

export const desktopScrollTool: Tool<ScrollInput> = {
  name: DESKTOP_SCROLL_NAME,
  description: DESKTOP_SCROLL_DESCRIPTION,
  schema: scrollSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const { win, error } = requireWindow(input.sessionId, input.windowId)
    if (error) return error
    try {
      const driver = await getDesktopDriver()
      const x = toClientCoord(input.sessionId, input.windowId, input.x, input.coordinateSpace)
      const y = toClientCoord(input.sessionId, input.windowId, input.y, input.coordinateSpace)
      const res = await driver.mouseScroll(win.nativeHandle, {
        x,
        y,
        deltaY: input.deltaY,
        deltaX: input.deltaX,
        mode: input.mode
      })
      if (!res.ok) return { content: res.message ?? '滚动失败', isError: true }
      return { content: `Scrolled at client (${Math.round(x)}, ${Math.round(y)}) deltaY=${input.deltaY ?? 0} deltaX=${input.deltaX ?? 0}.` }
    } catch (e) {
      return driverError(e)
    }
  }
}
// [KEY]
const keySchema = z.object({
  sessionId: z.string().min(1).describe('Desktop session id'),
  windowId: z.string().min(1).describe('Window id from DesktopGetWindow'),
  combo: z.string().min(1).describe('Key chord, e.g. "ctrl+c", "alt+tab", "enter", "f5"'),
  mode: pointerModeSchema
})
type KeyInput = z.infer<typeof keySchema>

export const desktopKeyTool: Tool<KeyInput> = {
  name: DESKTOP_KEY_NAME,
  description: DESKTOP_KEY_DESCRIPTION,
  schema: keySchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const { win, error } = requireWindow(input.sessionId, input.windowId)
    if (error) return error
    try {
      const driver = await getDesktopDriver()
      const res = await driver.pressKeys(win.nativeHandle, { combo: input.combo, mode: input.mode })
      if (!res.ok) return { content: res.message ?? '按键失败', isError: true }
      return { content: `Pressed ${input.combo}.` }
    } catch (e) {
      return driverError(e)
    }
  }
}
// [SCREENSHOT]
const screenshotSchema = z.object({
  sessionId: z.string().min(1).describe('Desktop session id'),
  windowId: z.string().min(1).describe('Window id from DesktopGetWindow'),
  maxDimension: z
    .number()
    .int()
    .min(320)
    .max(4096)
    .optional()
    .describe('Cap the screenshot longest side in pixels (default 1280) to lower vision-token cost')
})
type ScreenshotInput = z.infer<typeof screenshotSchema>

export const desktopScreenshotTool: Tool<ScreenshotInput> = {
  name: DESKTOP_SCREENSHOT_NAME,
  description: DESKTOP_SCREENSHOT_DESCRIPTION,
  schema: screenshotSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    const { win, error } = requireWindow(input.sessionId, input.windowId)
    if (error) return error
    try {
      const driver = await getDesktopDriver()
      const maxDimension = input.maxDimension ?? DEFAULT_SCREENSHOT_MAX_DIM
      const shot = await driver.screenshot(win.nativeHandle, { maxDimension })
      if (shot.buffer.length > MAX_SCREENSHOT_BYTES) {
        return {
          content: '截图过大，无法内嵌显示。请缩小窗口或调低 maxDimension 后重试。',
          isError: true
        }
      }
      // 记录缩放系数，使坐标工具可接受「图片像素坐标」并自动还原为客户区坐标。
      setWindowScreenshotScale(input.sessionId, input.windowId, shot.scale)
      const previewId = await storeBrowserPreview(shot.buffer, shot.mime)
      const dataUrl = `data:${shot.mime};base64,${shot.buffer.toString('base64')}`
      if (ctx.emitEvent && ctx.turnId && ctx.toolCallId) {
        ctx.emitEvent({
          type: 'tool_call_progress',
          turnId: ctx.turnId,
          callId: ctx.toolCallId,
          status: 'running',
          message: 'Window screenshot captured.'
        })
      }
      const scaledNote =
        shot.scale < 0.999
          ? `\n\n（图片为 ${shot.imageWidth}×${shot.imageHeight}，已从客户区 ${shot.clientWidth}×${shot.clientHeight} 缩小；点击坐标可直接读图，工具会自动还原。）`
          : ''
      return {
        content: `Screenshot of "${win.title}" (${shot.imageWidth}×${shot.imageHeight}px):\n\n![screenshot](${browserPreviewUrl(previewId)})${scaledNote}`,
        // 仅当模型开启视觉时由编排层附带；否则自动丢弃，仅保留文本。
        images: [{ dataUrl }]
      }
    } catch (e) {
      return driverError(e)
    }
  }
}
// [WAITFOR]
const waitForSchema = z
  .object({
    sessionId: z.string().optional().describe('Existing desktop session id; omit to create one'),
    title: z.string().optional().describe('Window title substring to wait for'),
    processName: z.string().optional().describe('Owning process name to wait for'),
    timeoutMs: z.number().int().min(100).max(120_000).optional().describe('Max wait in ms (default 15000)')
  })
  .refine((v) => v.title || v.processName, { message: 'Provide title and/or processName' })
type WaitForInput = z.infer<typeof waitForSchema>

export const desktopWaitForTool: Tool<WaitForInput> = {
  name: DESKTOP_WAIT_FOR_NAME,
  description: DESKTOP_WAIT_FOR_DESCRIPTION,
  schema: waitForSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const driver = await getDesktopDriver()
      const session = input.sessionId
        ? getDesktopSession(input.sessionId) ?? ensureDesktopSession(ctx.sessionId)
        : ensureDesktopSession(ctx.sessionId)
      const win = await driver.waitForWindow(
        { title: input.title, processName: input.processName },
        input.timeoutMs ?? DEFAULT_WAIT_MS
      )
      if (!win) return { content: '等待窗口超时。', isError: true }
      const ref = registerWindow(session.id, win)
      return {
        content: `Window appeared.\nwindowId: ${ref?.windowId}\nsessionId: ${session.id}\n${describeWindow(win)}${routingAdvisory(win)}`
      }
    } catch (e) {
      return driverError(e)
    }
  }
}
// [HANDOFF]
const handoffSchema = z.object({
  sessionId: z.string().min(1).describe('Desktop session id'),
  windowId: z.string().optional().describe('Window id to preview (optional)'),
  message: z.string().min(1).describe('What the user should do on the computer')
})
type HandoffInput = z.infer<typeof handoffSchema>

export const desktopHandoffTool: Tool<HandoffInput> = {
  name: DESKTOP_HANDOFF_NAME,
  description: DESKTOP_HANDOFF_DESCRIPTION,
  schema: handoffSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    const session = getDesktopSession(input.sessionId)
    if (!session || session.status !== 'open') {
      return { content: `桌面会话不存在或已关闭：${input.sessionId}`, isError: true }
    }
    if (!ctx.requestUserQuestion) {
      return { content: 'DesktopHandoff 需要编排层提供 requestUserQuestion 能力', isError: true }
    }
    let previewImageId: string | undefined
    let previewNote = ''
    const win = input.windowId ? getWindow(input.sessionId, input.windowId) : undefined
    if (win) {
      try {
        const driver = await getDesktopDriver()
        const shot = await driver.screenshot(win.nativeHandle)
        previewImageId = await storeBrowserPreview(shot.buffer, shot.mime)
      } catch {
        previewNote = '\n\n（窗口预览不可用，请直接查看屏幕上的窗口。）'
      }
    }
    const question = `${input.message}${previewNote}\n\n请在电脑上完成上述操作，完成后点击下方按钮继续。`
    const response = await ctx.requestUserQuestion(question, ['已完成，继续'], { previewImageId })
    if (response.cancelled) {
      return { content: '用户取消了手动操作（handoff cancelled）。', isError: true }
    }
    return { content: '用户已完成手动操作，可继续。' }
  }
}
// [CLOSE]
const closeSchema = z
  .object({
    sessionId: z.string().optional().describe('Desktop session id'),
    processId: z.number().int().optional().describe('Process id from DesktopLaunchApp'),
    windowId: z.string().optional().describe('Window id from DesktopGetWindow'),
    force: z.boolean().optional().describe('Force-kill instead of graceful close')
  })
  .refine((v) => v.processId !== undefined || v.windowId, {
    message: 'Provide processId or windowId'
  })
type CloseInput = z.infer<typeof closeSchema>

export const desktopCloseAppTool: Tool<CloseInput> = {
  name: DESKTOP_CLOSE_APP_NAME,
  description: DESKTOP_CLOSE_APP_DESCRIPTION,
  schema: closeSchema,
  readOnly: false,
  concurrencySafe: false,
  destructive: true,
  async execute(input): Promise<ToolResult> {
    try {
      const driver = await getDesktopDriver()
      let nativeHandle: string | undefined
      if (input.windowId && input.sessionId) {
        nativeHandle = getWindow(input.sessionId, input.windowId)?.nativeHandle
      }
      const res = await driver.closeApp(
        { processId: input.processId, nativeHandle },
        input.force ?? false
      )
      if (!res.ok) return { content: res.message ?? '关闭失败', isError: true }
      return { content: `Close requested.${res.message ? ` (${res.message})` : ''}` }
    } catch (e) {
      return driverError(e)
    }
  }
}
// [CLOSE_END]

export const desktopTools = [
  desktopLaunchAppTool,
  desktopListWindowsTool,
  desktopGetWindowTool,
  desktopSnapshotTool,
  desktopClickTool,
  desktopTypeTool,
  desktopMouseTool,
  desktopMouseMoveTool,
  desktopDragTool,
  desktopScrollTool,
  desktopKeyTool,
  desktopScreenshotTool,
  desktopWaitForTool,
  desktopHandoffTool,
  desktopCloseAppTool
]
