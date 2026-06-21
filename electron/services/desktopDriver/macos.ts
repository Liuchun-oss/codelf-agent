import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { tmpName } from '@shared/appConfig'
import {
  DesktopDriverError,
  type DesktopDriver,
  type DriverActionResult,
  type LaunchResult,
  type MouseButton,
  type MouseClickOptions,
  type MouseDragOptions,
  type MouseMoveOptions,
  type MouseScrollOptions,
  type ScreenshotResult,
  type SnapshotResult,
  type UiNode,
  type WindowInfo
} from './index'

const AX_PERMISSION_GUIDANCE =
  '请在「系统设置 > 隐私与安全性 > 辅助功能」中允许本应用控制电脑；截图功能还需在「屏幕录制」中授权。授权后重试。'

function runProcess(
  cmd: string,
  args: string[],
  input: string | undefined,
  timeoutMs: number
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(cmd, args)
    const timer = setTimeout(() => {
      child.kill()
      reject(new DesktopDriverError(`${cmd} 执行超时`))
    }, timeoutMs)
    child.stdout?.on('data', (b: Buffer) => (stdout += b.toString('utf8')))
    child.stderr?.on('data', (b: Buffer) => (stderr += b.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new DesktopDriverError(err instanceof Error ? err.message : String(err)))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const errText = stderr.trim()
      if (/not allowed assistive|accessibility|osascript is not allowed/i.test(errText)) {
        reject(new DesktopDriverError('缺少辅助功能权限', AX_PERMISSION_GUIDANCE))
        return
      }
      if (code === 0) resolve(stdout.trim())
      else reject(new DesktopDriverError(errText || `${cmd} 退出码 ${code}`))
    })
    if (input !== undefined) {
      child.stdin?.write(input)
      child.stdin?.end()
    }
  })
}

function osascript(script: string, timeoutMs = 15_000): Promise<string> {
  return runProcess('osascript', ['-'], script, timeoutMs)
}

export class MacosDesktopDriver implements DesktopDriver {
  readonly platform: NodeJS.Platform = 'darwin'

  async launchApp(app: string, args: string[] = []): Promise<LaunchResult> {
    // -a 按应用名/路径打开；附加参数经 --args 传入。
    const openArgs = ['-a', app]
    if (args.length) openArgs.push('--args', ...args)
    await runProcess('open', openArgs, undefined, 20_000)
    // open 不返回 pid，回查最前台应用的进程信息。
    const script = [
      'tell application "System Events"',
      '  set frontApp to first application process whose frontmost is true',
      '  set pid to unix id of frontApp',
      '  set pname to name of frontApp',
      '  return (pid as string) & "\\n" & pname',
      'end tell'
    ].join('\n')
    const out = await osascript(script)
    const [pidStr, ...nameParts] = out.split('\n')
    return { processId: Number.parseInt(pidStr, 10) || 0, processName: nameParts.join('\n').trim() || app }
  }

  // [LIST_WINDOWS]
  async listWindows(): Promise<WindowInfo[]> {
    // 遍历有窗口的可见进程，输出 进程名|pid|窗口标题，每行一个窗口。
    const script = [
      'set output to ""',
      'tell application "System Events"',
      '  set procs to (every application process whose visible is true)',
      '  repeat with p in procs',
      '    set pname to name of p',
      '    set pid to unix id of p',
      '    try',
      '      repeat with w in (windows of p)',
      '        set wtitle to name of w',
      '        set output to output & pname & "\\t" & (pid as string) & "\\t" & wtitle & "\\n"',
      '      end repeat',
      '    end try',
      '  end repeat',
      'end tell',
      'return output'
    ].join('\n')
    const out = await osascript(script)
    const windows: WindowInfo[] = []
    for (const line of out.split('\n')) {
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const [processName, pidStr, ...titleParts] = parts
      const title = titleParts.join('\t').trim()
      if (!title) continue
      const processId = Number.parseInt(pidStr, 10) || 0
      // macOS 无 HWND，用 "pid:title" 作为定位句柄。
      windows.push({
        nativeHandle: `${processId}:${title}`,
        title,
        processName,
        processId
      })
    }
    return windows
  }

  async findWindow(query: {
    title?: string
    processName?: string
    nativeHandle?: string
  }): Promise<WindowInfo | null> {
    const windows = await this.listWindows()
    const match = windows.find((w) => {
      if (query.nativeHandle && w.nativeHandle !== query.nativeHandle) return false
      if (query.processName && w.processName.toLowerCase() !== query.processName.toLowerCase())
        return false
      if (query.title && !w.title.toLowerCase().includes(query.title.toLowerCase())) return false
      return true
    })
    return match ?? null
  }

  // [SNAPSHOT]
  // 解析 "pid:title" 句柄。
  private parseHandle(nativeHandle: string): { pid: number; title: string } {
    const sep = nativeHandle.indexOf(':')
    if (sep < 0) return { pid: Number.parseInt(nativeHandle, 10) || 0, title: '' }
    return {
      pid: Number.parseInt(nativeHandle.slice(0, sep), 10) || 0,
      title: nativeHandle.slice(sep + 1)
    }
  }

  // 通过 System Events 的 AX 接口枚举目标窗口内可交互的 UI 元素。
  async snapshot(nativeHandle: string, maxNodes: number): Promise<SnapshotResult> {
    const { pid, title } = this.parseHandle(nativeHandle)
    const script = [
      'set output to ""',
      'set counter to 0',
      'set emitted to 0',
      `set maxNodes to ${maxNodes}`,
      'tell application "System Events"',
      `  set p to first application process whose unix id is ${pid}`,
      `  set w to (first window of p whose name is ${JSON.stringify(title)})`,
      '  set {wx, wy} to position of w',
      '  set els to entire contents of w',
      '  repeat with e in els',
      '    set counter to counter + 1',
      '    if emitted ≥ maxNodes then exit repeat',
      '    try',
      '      set r to role of e',
      '      set n to ""',
      '      try',
      '        set n to name of e',
      '      end try',
      '      set cxv to ""',
      '      set cyv to ""',
      '      try',
      '        set {ex, ey} to position of e',
      '        set {ew, eh} to size of e',
      '        set cxv to (ex + (ew div 2) - wx)',
      '        set cyv to (ey + (eh div 2) - wy)',
      '      end try',
      '      set output to output & counter & "\\t" & r & "\\t" & n & "\\t" & cxv & "\\t" & cyv & "\\n"',
      '      set emitted to emitted + 1',
      '    end try',
      '  end repeat',
      'end tell',
      'return output'
    ].join('\n')
    const out = await osascript(script, 30_000)
    const lines = out.split('\n').filter((l) => l.includes('\t'))
    const truncated = lines.length >= maxNodes
    const nodes: UiNode[] = lines.map((line) => {
      // 坐标固定为最后两列；名称可能含制表符，故从两端取、中间归为 name。
      const parts = line.split('\t')
      const idx = parts[0]
      const role = parts[1] ?? ''
      const cy = parts.length >= 5 ? parts[parts.length - 1] : ''
      const cx = parts.length >= 5 ? parts[parts.length - 2] : ''
      const name = (parts.length >= 5 ? parts.slice(2, parts.length - 2) : parts.slice(2)).join('\t').trim()
      const lowered = role.toLowerCase()
      const actionable = /button|menuitem|checkbox|radio|link|tab/.test(lowered)
      const editable = /textfield|textarea|combobox|searchfield/.test(lowered)
      const node: UiNode = {
        ref: `n${(idx ?? '').trim()}`,
        role: role || 'unknown',
        name,
        actionable,
        editable
      }
      const px = Number.parseInt((cx ?? '').trim(), 10)
      const py = Number.parseInt((cy ?? '').trim(), 10)
      if (Number.isFinite(px) && Number.isFinite(py)) node.center = { x: px, y: py }
      return node
    })
    return { nodes, truncated }
  }

  // [CLICK_TYPE]
  // 按 ref 索引在 entire contents 中重新定位元素并操作（ref 即 entire contents 的 1-based 绝对位置）。
  private elementSelector(pid: number, title: string, ref: string): string {
    const idx = Number.parseInt(ref.replace(/^n/, ''), 10) || 0
    return [
      `set p to first application process whose unix id is ${pid}`,
      `set w to (first window of p whose name is ${JSON.stringify(title)})`,
      'set els to entire contents of w',
      `set target to item ${idx} of els`
    ].join('\n')
  }

  async click(nativeHandle: string, ref: string): Promise<DriverActionResult> {
    const { pid, title } = this.parseHandle(nativeHandle)
    const script = [
      'tell application "System Events"',
      this.elementSelector(pid, title, ref),
      '  try',
      '    perform action "AXPress" of target',
      '  on error',
      '    click target',
      '  end try',
      'end tell',
      'return "ok"'
    ].join('\n')
    const out = await osascript(script)
    return { ok: true, message: out }
  }

  async type(
    nativeHandle: string,
    ref: string,
    text: string,
    submit: boolean
  ): Promise<DriverActionResult> {
    const { pid, title } = this.parseHandle(nativeHandle)
    const script = [
      'tell application "System Events"',
      this.elementSelector(pid, title, ref),
      `  set value of target to ${JSON.stringify(text)}`,
      submit ? '  set frontmost of p to true' : '',
      submit ? '  key code 36' : '',
      'end tell',
      'return "ok"'
    ]
      .filter(Boolean)
      .join('\n')
    const out = await osascript(script)
    return { ok: true, message: out }
  }

  // [MOUSE]
  // macOS 坐标级鼠标：经 python3 + Quartz(CoreGraphics) 合成 CGEvent。
  // - 'virtual'/'auto' 用 CGEventPostToPid 投递给目标进程，尽量减少对用户的干扰；
  // - 'real' 用 CGEventPost(HID) 走系统事件（会移动真实光标，兼容性最好）。
  // 传入坐标为窗口客户区相对坐标，运行时用 AX 读窗口原点换算为全局屏幕坐标。
  private buttonConst(button: MouseButton): { down: string; up: string; btn: string } {
    if (button === 'right')
      return { down: 'kCGEventRightMouseDown', up: 'kCGEventRightMouseUp', btn: 'kCGMouseButtonRight' }
    if (button === 'middle')
      return { down: 'kCGEventOtherMouseDown', up: 'kCGEventOtherMouseUp', btn: 'kCGMouseButtonCenter' }
    return { down: 'kCGEventLeftMouseDown', up: 'kCGEventLeftMouseUp', btn: 'kCGMouseButtonLeft' }
  }

  // 读取窗口左上角全局坐标，作为客户区坐标的原点。
  private async windowOrigin(pid: number, title: string): Promise<{ x: number; y: number }> {
    const script = [
      'tell application "System Events"',
      `  set p to first application process whose unix id is ${pid}`,
      `  set w to (first window of p whose name is ${JSON.stringify(title)})`,
      '  set {px, py} to position of w',
      '  return (px as string) & "," & (py as string)',
      'end tell'
    ].join('\n')
    const out = await osascript(script)
    const [x, y] = out.split(',').map((n) => Number.parseInt(n.trim(), 10))
    return { x: x || 0, y: y || 0 }
  }

  private runQuartz(body: string): Promise<string> {
    const py = [
      'import sys',
      'try:',
      '    import Quartz',
      'except Exception:',
      '    sys.stderr.write("missing-quartz")',
      '    sys.exit(3)',
      'import time',
      body
    ].join('\n')
    return runProcess('python3', ['-c', py], undefined, 20_000).catch((e) => {
      if (e instanceof DesktopDriverError && /missing-quartz/.test(e.message)) {
        throw new DesktopDriverError(
          'macOS 坐标级鼠标需要 python3 的 Quartz 绑定（PyObjC）。',
          '请安装：pip3 install pyobjc-framework-Quartz；或改用基于控件 ref 的 DesktopClick。'
        )
      }
      throw e
    })
  }

  // 生成事件投递行：仅 'real' 走 HID 系统事件（移动真实光标）；
  // 'virtual' 与 'auto' 均投递给指定 pid，不打扰用户。
  private postLine(mode: 'virtual' | 'real' | 'auto', pid: number): string {
    return mode === 'real'
      ? 'def _post(ev): Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)'
      : `def _post(ev): Quartz.CGEventPostToPid(${pid}, ev)`
  }

  async mouseClick(nativeHandle: string, options: MouseClickOptions): Promise<DriverActionResult> {
    const { pid, title } = this.parseHandle(nativeHandle)
    const origin = await this.windowOrigin(pid, title)
    const gx = origin.x + options.x
    const gy = origin.y + options.y
    const button = options.button ?? 'left'
    const mode = options.mode ?? 'auto'
    const c = this.buttonConst(button)
    const clicks = options.doubleClick ? 2 : 1
    const body = [
      this.postLine(mode, pid),
      `pt = Quartz.CGPointMake(${gx}, ${gy})`,
      `for i in range(${clicks}):`,
      `    d = Quartz.CGEventCreateMouseEvent(None, Quartz.${c.down}, pt, Quartz.${c.btn})`,
      '    Quartz.CGEventSetIntegerValueField(d, Quartz.kCGMouseEventClickState, i + 1)',
      '    _post(d); time.sleep(0.02)',
      `    u = Quartz.CGEventCreateMouseEvent(None, Quartz.${c.up}, pt, Quartz.${c.btn})`,
      '    Quartz.CGEventSetIntegerValueField(u, Quartz.kCGMouseEventClickState, i + 1)',
      '    _post(u); time.sleep(0.04)',
      'print("ok")'
    ].join('\n')
    const out = await this.runQuartz(body)
    return { ok: true, message: out }
  }

  async mouseMove(nativeHandle: string, options: MouseMoveOptions): Promise<DriverActionResult> {
    const { pid, title } = this.parseHandle(nativeHandle)
    const origin = await this.windowOrigin(pid, title)
    const gx = origin.x + options.x
    const gy = origin.y + options.y
    const mode = options.mode ?? 'auto'
    const body = [
      this.postLine(mode, pid),
      `pt = Quartz.CGPointMake(${gx}, ${gy})`,
      'ev = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, pt, Quartz.kCGMouseButtonLeft)',
      '_post(ev)',
      'print("ok")'
    ].join('\n')
    const out = await this.runQuartz(body)
    return { ok: true, message: out }
  }

  async mouseDrag(nativeHandle: string, options: MouseDragOptions): Promise<DriverActionResult> {
    const { pid, title } = this.parseHandle(nativeHandle)
    const origin = await this.windowOrigin(pid, title)
    const fx = origin.x + options.fromX
    const fy = origin.y + options.fromY
    const tx = origin.x + options.toX
    const ty = origin.y + options.toY
    const button = options.button ?? 'left'
    const mode = options.mode ?? 'auto'
    const steps = Math.max(2, Math.min(options.steps ?? 20, 200))
    const c = this.buttonConst(button)
    const dragType =
      button === 'right'
        ? 'kCGEventRightMouseDragged'
        : button === 'middle'
          ? 'kCGEventOtherMouseDragged'
          : 'kCGEventLeftMouseDragged'
    const body = [
      this.postLine(mode, pid),
      `fx, fy, tx, ty = ${fx}, ${fy}, ${tx}, ${ty}`,
      `steps = ${steps}`,
      `down = Quartz.CGEventCreateMouseEvent(None, Quartz.${c.down}, Quartz.CGPointMake(fx, fy), Quartz.${c.btn})`,
      '_post(down); time.sleep(0.03)',
      'for i in range(1, steps + 1):',
      '    ix = fx + (tx - fx) * i / steps',
      '    iy = fy + (ty - fy) * i / steps',
      `    mv = Quartz.CGEventCreateMouseEvent(None, Quartz.${dragType}, Quartz.CGPointMake(ix, iy), Quartz.${c.btn})`,
      '    _post(mv); time.sleep(0.01)',
      `up = Quartz.CGEventCreateMouseEvent(None, Quartz.${c.up}, Quartz.CGPointMake(tx, ty), Quartz.${c.btn})`,
      '_post(up)',
      'print("ok")'
    ].join('\n')
    const out = await this.runQuartz(body)
    return { ok: true, message: out }
  }

  async mouseScroll(nativeHandle: string, options: MouseScrollOptions): Promise<DriverActionResult> {
    const { pid, title } = this.parseHandle(nativeHandle)
    const origin = await this.windowOrigin(pid, title)
    const gx = origin.x + options.x
    const gy = origin.y + options.y
    const mode = options.mode ?? 'auto'
    // 滚轮按「行」单位，正 deltaY 向下滚动（CGEvent 中向下为负，取反）。
    const vy = Math.round(-(options.deltaY ?? 0) * 3)
    const vx = Math.round((options.deltaX ?? 0) * 3)
    const body = [
      this.postLine(mode, pid),
      `mv = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, Quartz.CGPointMake(${gx}, ${gy}), Quartz.kCGMouseButtonLeft)`,
      '_post(mv); time.sleep(0.02)',
      `ev = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 2, ${vy}, ${vx})`,
      '_post(ev)',
      'print("ok")'
    ].join('\n')
    const out = await this.runQuartz(body)
    return { ok: true, message: out }
  }

  // [SCREENSHOT]
  // 经 AX 取窗口位置与尺寸，再用 screencapture -R 截取该矩形区域。
  async screenshot(nativeHandle: string): Promise<ScreenshotResult> {
    const { pid, title } = this.parseHandle(nativeHandle)
    const boundsScript = [
      'tell application "System Events"',
      `  set p to first application process whose unix id is ${pid}`,
      `  set w to (first window of p whose name is ${JSON.stringify(title)})`,
      '  set {px, py} to position of w',
      '  set {sw, sh} to size of w',
      '  return (px as string) & "," & (py as string) & "," & (sw as string) & "," & (sh as string)',
      'end tell'
    ].join('\n')
    const bounds = await osascript(boundsScript)
    const [x, y, w, h] = bounds.split(',').map((n) => Number.parseInt(n.trim(), 10))
    if (!w || !h) throw new DesktopDriverError('窗口尺寸无效，可能已最小化')
    const outPath = join(tmpdir(), `${tmpName('desktop-shot')}-${randomUUID()}.png`)
    await runProcess(
      'screencapture',
      ['-x', '-R', `${x},${y},${w},${h}`, outPath],
      undefined,
      20_000
    ).catch((e) => {
      if (e instanceof DesktopDriverError) throw e
      throw new DesktopDriverError('截图失败', AX_PERMISSION_GUIDANCE)
    })
    try {
      const buffer = await readFile(outPath)
      return { buffer, mime: 'image/png' }
    } finally {
      await unlink(outPath).catch(() => {})
    }
  }

  // [WAIT_CLOSE]
  async waitForWindow(
    query: { title?: string; processName?: string },
    timeoutMs: number
  ): Promise<WindowInfo | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = await this.findWindow(query)
      if (found) return found
      await new Promise((r) => setTimeout(r, 500))
    }
    return null
  }

  async closeApp(
    target: { processId?: number; nativeHandle?: string },
    force: boolean
  ): Promise<DriverActionResult> {
    let pid = target.processId
    if (!pid && target.nativeHandle) pid = this.parseHandle(target.nativeHandle).pid
    if (!pid) return { ok: false, message: '未提供有效的进程或窗口' }
    if (force) {
      await runProcess('kill', ['-9', String(pid)], undefined, 10_000)
      return { ok: true, message: 'ok-force' }
    }
    const script = [
      'tell application "System Events"',
      `  set p to first application process whose unix id is ${pid}`,
      '  set pname to name of p',
      'end tell',
      'tell application pname to quit'
    ].join('\n')
    await osascript(script).catch(async () => {
      await runProcess('kill', [String(pid)], undefined, 10_000)
    })
    return { ok: true, message: 'ok-graceful' }
  }
}
