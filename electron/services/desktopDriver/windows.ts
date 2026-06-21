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
  type MouseClickOptions,
  type MouseDragOptions,
  type MouseMoveOptions,
  type MouseScrollOptions,
  type ScreenshotResult,
  type SnapshotResult,
  type UiNode,
  type WindowInfo
} from './index'

const PS_PREAMBLE = [
  '$ErrorActionPreference = "Stop"',
  '$ProgressPreference = "SilentlyContinue"',
  'Add-Type -AssemblyName UIAutomationClient',
  'Add-Type -AssemblyName UIAutomationTypes',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing'
].join('\n')

// 通过 -EncodedCommand 运行 PowerShell，stdout 以 UTF-8 捕获。
function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  const full = `${PS_PREAMBLE}\n[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n${script}`
  const encoded = Buffer.from(full, 'utf16le').toString('base64')
  return new Promise<string>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true }
    )
    const timer = setTimeout(() => {
      child.kill()
      reject(new DesktopDriverError('PowerShell 执行超时'))
    }, timeoutMs)
    child.stdout?.on('data', (b: Buffer) => (stdout += b.toString('utf8')))
    child.stderr?.on('data', (b: Buffer) => (stderr += b.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new DesktopDriverError(err instanceof Error ? err.message : String(err)))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim())
      else reject(new DesktopDriverError(stderr.trim() || `PowerShell 退出码 ${code}`))
    })
  })
}

function parseJsonArray<T>(raw: string): T[] {
  if (!raw) return []
  const parsed = JSON.parse(raw) as T | T[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

// PowerShell 单引号字符串转义。
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export class WindowsDesktopDriver implements DesktopDriver {
  readonly platform: NodeJS.Platform = 'win32'

  async launchApp(app: string, args: string[] = []): Promise<LaunchResult> {
    const argList = args.length ? ` -ArgumentList @(${args.map(psQuote).join(',')})` : ''
    const script = [
      `$p = Start-Process -FilePath ${psQuote(app)}${argList} -PassThru`,
      'Start-Sleep -Milliseconds 300',
      '$p = Get-Process -Id $p.Id -ErrorAction SilentlyContinue',
      'if ($null -eq $p) { throw "进程启动后立即退出" }',
      '@{ processId = $p.Id; processName = $p.ProcessName } | ConvertTo-Json -Compress'
    ].join('\n')
    const raw = await runPowerShell(script, 20_000)
    const obj = JSON.parse(raw) as { processId: number; processName: string }
    return { processId: obj.processId, processName: obj.processName }
  }

  // [LIST_WINDOWS]
  async listWindows(): Promise<WindowInfo[]> {
    const script = [
      '$ws = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne "" }',
      '$out = foreach ($p in $ws) {',
      '  @{ nativeHandle = [string]$p.MainWindowHandle; title = $p.MainWindowTitle; processName = $p.ProcessName; processId = $p.Id }',
      '}',
      'ConvertTo-Json -Compress -InputObject @($out)'
    ].join('\n')
    const raw = await runPowerShell(script, 15_000)
    return parseJsonArray<WindowInfo>(raw)
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
  // 找到 HWND 对应的 AutomationElement，再按 ControlViewWalker 广度遍历，
  // 收集可交互控件（按钮、输入框、列表项等），每个节点带稳定 ref（运行时索引）。
  async snapshot(nativeHandle: string, maxNodes: number): Promise<SnapshotResult> {
    const script = [
      `$hwnd = [IntPtr]::new([int64]${psQuote(nativeHandle)})`,
      '$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)',
      'if ($null -eq $root) { throw "无法从句柄获取窗口元素" }',
      'Add-Type -MemberDefinition @"',
      '[DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);',
      'public struct POINT { public int X; public int Y; }',
      '"@ -Name SnapNative -Namespace DesktopCtl',
      '$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
      '$nodes = New-Object System.Collections.ArrayList',
      `$max = ${maxNodes}`,
      '$queue = New-Object System.Collections.Queue',
      '$queue.Enqueue($root)',
      '$idx = 0',
      '$truncated = $false',
      'while ($queue.Count -gt 0) {',
      '  if ($nodes.Count -ge $max) { $truncated = $true; break }',
      '  $el = $queue.Dequeue()',
      '  $cur = $idx',
      '  $idx++',
      '  try {',
      '    $ct = $el.Current.ControlType.ProgrammaticName -replace "ControlType.",""',
      '    $name = $el.Current.Name',
      '    $patterns = $el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }',
      '    $actionable = ($patterns -match "Invoke|Toggle|SelectionItem|ExpandCollapse").Count -gt 0',
      '    $editable = ($patterns -match "Value|Text").Count -gt 0',
      '    if (($name -ne "" -or $actionable -or $editable)) {',
      '      $r = $el.Current.BoundingRectangle',
      '      $cp = New-Object DesktopCtl.SnapNative+POINT; $cp.X = [int]($r.X + $r.Width/2); $cp.Y = [int]($r.Y + $r.Height/2)',
      '      [void][DesktopCtl.SnapNative]::ScreenToClient($hwnd, [ref]$cp)',
      '      [void]$nodes.Add(@{ ref = "n$cur"; role = $ct; name = $name; actionable = $actionable; editable = $editable; bounds = @{ x=[int]$r.X; y=[int]$r.Y; width=[int]$r.Width; height=[int]$r.Height }; center = @{ x=[int]$cp.X; y=[int]$cp.Y } })',
      '    }',
      '  } catch {}',
      '  try {',
      '    $child = $walker.GetFirstChild($el)',
      '    while ($null -ne $child) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }',
      '  } catch {}',
      '}',
      'ConvertTo-Json -Compress -Depth 5 -InputObject @{ nodes = @($nodes); truncated = $truncated }'
    ].join('\n')
    const raw = await runPowerShell(script, 30_000)
    const parsed = JSON.parse(raw) as { nodes: UiNode[]; truncated: boolean }
    return { nodes: parsed.nodes ?? [], truncated: !!parsed.truncated }
  }

  // [CLICK_TYPE]
  // 按 ref 重走同一遍历顺序定位目标元素，优先用无障碍 pattern 操作，失败降级到坐标点击。
  private locateElementScript(nativeHandle: string, ref: string): string {
    const targetIdx = ref.replace(/^n/, '')
    return [
      `$hwnd = [IntPtr]::new([int64]${psQuote(nativeHandle)})`,
      '$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)',
      'if ($null -eq $root) { throw "无法从句柄获取窗口元素" }',
      '$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
      '$queue = New-Object System.Collections.Queue',
      '$queue.Enqueue($root)',
      '$idx = 0',
      '$target = $null',
      `$want = ${targetIdx}`,
      'while ($queue.Count -gt 0) {',
      '  $el = $queue.Dequeue()',
      '  if ($idx -eq $want) { $target = $el; break }',
      '  $idx++',
      '  try {',
      '    $child = $walker.GetFirstChild($el)',
      '    while ($null -ne $child) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }',
      '  } catch {}',
      '}',
      'if ($null -eq $target) { throw "未找到 ref 对应的控件，请重新 DesktopSnapshot" }'
    ].join('\n')
  }

  async click(nativeHandle: string, ref: string): Promise<DriverActionResult> {
    const script = [
      this.locateElementScript(nativeHandle, ref),
      '$invoke = $null',
      'try { $invoke = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) } catch {}',
      'if ($null -ne $invoke) { $invoke.Invoke(); "ok-invoke" }',
      'else {',
      '  try { $tp = $target.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $tp.Toggle(); "ok-toggle" }',
      '  catch {',
      '    $r = $target.Current.BoundingRectangle',
      '    $cx = [int]($r.X + $r.Width/2); $cy = [int]($r.Y + $r.Height/2)',
      '    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($cx, $cy)',
      '    Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);\' -Name M -Namespace W',
      '    [W.M]::mouse_event(0x02,0,0,0,0); [W.M]::mouse_event(0x04,0,0,0,0); "ok-coord"',
      '  }',
      '}'
    ].join('\n')
    const out = await runPowerShell(script, 15_000)
    return { ok: true, message: out }
  }

  // [TYPE]
  async type(
    nativeHandle: string,
    ref: string,
    text: string,
    submit: boolean
  ): Promise<DriverActionResult> {
    const script = [
      this.locateElementScript(nativeHandle, ref),
      '$vp = $null',
      'try { $vp = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}',
      `$text = ${psQuote(text)}`,
      'if ($null -ne $vp -and -not $vp.Current.IsReadOnly) { $vp.SetValue($text) }',
      'else {',
      '  try { $target.SetFocus() } catch {}',
      '  Start-Sleep -Milliseconds 100',
      '  [System.Windows.Forms.SendKeys]::SendWait("^a")',
      "  $escaped = $text -replace '([+^%~(){}\\[\\]])', '{$1}'",
      '  [System.Windows.Forms.SendKeys]::SendWait($escaped)',
      '}',
      submit ? '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")' : '',
      '"ok"'
    ]
      .filter(Boolean)
      .join('\n')
    const out = await runPowerShell(script, 15_000)
    return { ok: true, message: out }
  }

  // [MOUSE]
  // 鼠标原生能力：虚拟模式经 PostMessage 向窗口投递消息（不动真实光标）；
  // 真实模式经 SetCursorPos + mouse_event（会移动系统光标）。
  private mouseNativeTypes(): string {
    return [
      'Add-Type -MemberDefinition @"',
      '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);',
      '[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);',
      '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
      '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, UIntPtr extra);',
      '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
      'public struct POINT { public int X; public int Y; }',
      '"@ -Name MouseNative -Namespace DesktopCtl'
    ].join('\n')
  }

  // 把客户区坐标打包进 lParam，并裁剪为有符号 32 位整数（PostMessage 所需）。
  private static packCoord(x: number, y: number): number {
    const raw = ((Math.round(y) & 0xffff) << 16) | (Math.round(x) & 0xffff)
    return raw | 0
  }

  private buttonMk(button: 'left' | 'right' | 'middle'): number {
    if (button === 'right') return 0x0002
    if (button === 'middle') return 0x0010
    return 0x0001
  }

  private buttonMsgs(button: 'left' | 'right' | 'middle') {
    if (button === 'right') return { down: 0x0204, up: 0x0205, dbl: 0x0206 }
    if (button === 'middle') return { down: 0x0207, up: 0x0208, dbl: 0x0209 }
    return { down: 0x0201, up: 0x0202, dbl: 0x0203 }
  }

  // 真实模式按键 flags（mouse_event）。
  private buttonRealFlags(button: 'left' | 'right' | 'middle') {
    if (button === 'right') return { down: '0x0008', up: '0x0010' }
    if (button === 'middle') return { down: '0x0020', up: '0x0040' }
    return { down: '0x0002', up: '0x0004' }
  }

  // 真实模式：把客户区坐标转屏幕坐标，移动光标到该点。
  private realMoveLines(): string[] {
    return [
      '$sp = New-Object DesktopCtl.MouseNative+POINT; $sp.X = $cx; $sp.Y = $cy',
      '[void][DesktopCtl.MouseNative]::ClientToScreen($hwnd, [ref]$sp)',
      '[void][DesktopCtl.MouseNative]::SetCursorPos($sp.X, $sp.Y)'
    ]
  }

  // 统一运行：组装 native 类型 + hwnd + cx/cy，再按模式执行虚拟或真实脚本。
  private async runMouse(
    nativeHandle: string,
    cx: number,
    cy: number,
    mode: 'virtual' | 'real' | 'auto',
    virtualBody: string,
    realBody: string
  ): Promise<DriverActionResult> {
    const useReal = mode === 'real'
    const script = [
      `$hwnd = [IntPtr]::new([int64]${psQuote(nativeHandle)})`,
      this.mouseNativeTypes(),
      `$cx = ${Math.round(cx)}; $cy = ${Math.round(cy)}`,
      useReal ? realBody : virtualBody,
      useReal ? '"ok-real"' : '"ok-virtual"'
    ].join('\n')
    const out = await runPowerShell(script, 15_000)
    return { ok: true, message: out }
  }

  async mouseClick(nativeHandle: string, options: MouseClickOptions): Promise<DriverActionResult> {
    const button = options.button ?? 'left'
    const mode = options.mode ?? 'auto'
    const dbl = options.doubleClick ?? false
    const msgs = this.buttonMsgs(button)
    const mk = this.buttonMk(button)
    const lp = WindowsDesktopDriver.packCoord(options.x, options.y)
    const post = (msg: number, w: number) =>
      `[void][DesktopCtl.MouseNative]::PostMessage($hwnd, ${msg}, [IntPtr]${w}, [IntPtr]${lp})`
    const virtualBody = [
      post(0x0200, 0),
      post(msgs.down, mk),
      post(msgs.up, 0),
      dbl ? post(msgs.dbl, mk) : '',
      dbl ? post(msgs.up, 0) : ''
    ]
      .filter(Boolean)
      .join('\n')
    const f = this.buttonRealFlags(button)
    const onceReal = `[DesktopCtl.MouseNative]::mouse_event(${f.down},0,0,0,[UIntPtr]::Zero); [DesktopCtl.MouseNative]::mouse_event(${f.up},0,0,0,[UIntPtr]::Zero)`
    const realBody = [
      '[void][DesktopCtl.MouseNative]::SetForegroundWindow($hwnd)',
      ...this.realMoveLines(),
      'Start-Sleep -Milliseconds 30',
      onceReal,
      dbl ? `Start-Sleep -Milliseconds 60; ${onceReal}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    return this.runMouse(nativeHandle, options.x, options.y, mode, virtualBody, realBody)
  }

  async mouseMove(nativeHandle: string, options: MouseMoveOptions): Promise<DriverActionResult> {
    const mode = options.mode ?? 'auto'
    const lp = WindowsDesktopDriver.packCoord(options.x, options.y)
    const virtualBody = `[void][DesktopCtl.MouseNative]::PostMessage($hwnd, 0x0200, [IntPtr]0, [IntPtr]${lp})`
    const realBody = this.realMoveLines().join('\n')
    return this.runMouse(nativeHandle, options.x, options.y, mode, virtualBody, realBody)
  }

  async mouseDrag(nativeHandle: string, options: MouseDragOptions): Promise<DriverActionResult> {
    const button = options.button ?? 'left'
    const mode = options.mode ?? 'auto'
    const steps = Math.max(2, Math.min(options.steps ?? 20, 200))
    const msgs = this.buttonMsgs(button)
    const mk = this.buttonMk(button)
    const fromLp = WindowsDesktopDriver.packCoord(options.fromX, options.fromY)
    const moves: string[] = []
    for (let i = 1; i <= steps; i++) {
      const ix = options.fromX + ((options.toX - options.fromX) * i) / steps
      const iy = options.fromY + ((options.toY - options.fromY) * i) / steps
      const lp = WindowsDesktopDriver.packCoord(ix, iy)
      moves.push(
        `[void][DesktopCtl.MouseNative]::PostMessage($hwnd, 0x0200, [IntPtr]${mk}, [IntPtr]${lp}); Start-Sleep -Milliseconds 10`
      )
    }
    const virtualBody = [
      `[void][DesktopCtl.MouseNative]::PostMessage($hwnd, 0x0200, [IntPtr]0, [IntPtr]${fromLp})`,
      `[void][DesktopCtl.MouseNative]::PostMessage($hwnd, ${msgs.down}, [IntPtr]${mk}, [IntPtr]${fromLp})`,
      ...moves,
      `[void][DesktopCtl.MouseNative]::PostMessage($hwnd, ${msgs.up}, [IntPtr]0, [IntPtr]${WindowsDesktopDriver.packCoord(options.toX, options.toY)})`
    ].join('\n')
    const realBody = this.realDragBody(button, options, steps)
    return this.runMouse(nativeHandle, options.fromX, options.fromY, mode, virtualBody, realBody)
  }

  // 真实模式拖拽：移动到起点按下，分步移动到终点，再抬起。
  private realDragBody(
    button: 'left' | 'right' | 'middle',
    options: MouseDragOptions,
    steps: number
  ): string {
    const f = this.buttonRealFlags(button)
    const lines: string[] = ['[void][DesktopCtl.MouseNative]::SetForegroundWindow($hwnd)']
    const moveTo = (x: number, y: number) => [
      `$sp = New-Object DesktopCtl.MouseNative+POINT; $sp.X = ${Math.round(x)}; $sp.Y = ${Math.round(y)}`,
      '[void][DesktopCtl.MouseNative]::ClientToScreen($hwnd, [ref]$sp)',
      '[void][DesktopCtl.MouseNative]::SetCursorPos($sp.X, $sp.Y)'
    ]
    lines.push(...moveTo(options.fromX, options.fromY))
    lines.push('Start-Sleep -Milliseconds 30')
    lines.push(`[DesktopCtl.MouseNative]::mouse_event(${f.down},0,0,0,[UIntPtr]::Zero)`)
    for (let i = 1; i <= steps; i++) {
      const ix = options.fromX + ((options.toX - options.fromX) * i) / steps
      const iy = options.fromY + ((options.toY - options.fromY) * i) / steps
      lines.push(...moveTo(ix, iy))
      lines.push('Start-Sleep -Milliseconds 10')
    }
    lines.push(`[DesktopCtl.MouseNative]::mouse_event(${f.up},0,0,0,[UIntPtr]::Zero)`)
    return lines.join('\n')
  }

  async mouseScroll(nativeHandle: string, options: MouseScrollOptions): Promise<DriverActionResult> {
    const mode = options.mode ?? 'auto'
    const ticks = options.deltaY ?? 0
    const hticks = options.deltaX ?? 0
    const wheelDelta = (Math.round(-ticks) * 120) | 0
    const hWheelDelta = (Math.round(hticks) * 120) | 0
    const lp = WindowsDesktopDriver.packCoord(options.x, options.y)
    // WM_MOUSEWHEEL/HWHEEL：lParam 应为屏幕坐标，运行时用 ClientToScreen 换算。
    const screenLp =
      '$pt = New-Object DesktopCtl.MouseNative+POINT; $pt.X = $cx; $pt.Y = $cy; [void][DesktopCtl.MouseNative]::ClientToScreen($hwnd, [ref]$pt); $slp = [IntPtr]((($pt.Y -band 0xffff) -shl 16) -bor ($pt.X -band 0xffff))'
    const vParts: string[] = [`[void][DesktopCtl.MouseNative]::PostMessage($hwnd, 0x0200, [IntPtr]0, [IntPtr]${lp})`, screenLp]
    if (wheelDelta !== 0) {
      vParts.push(`[void][DesktopCtl.MouseNative]::PostMessage($hwnd, 0x020a, [IntPtr]${(wheelDelta << 16) | 0}, $slp)`)
    }
    if (hWheelDelta !== 0) {
      vParts.push(`[void][DesktopCtl.MouseNative]::PostMessage($hwnd, 0x020e, [IntPtr]${(hWheelDelta << 16) | 0}, $slp)`)
    }
    const realParts: string[] = [...this.realMoveLines(), 'Start-Sleep -Milliseconds 20']
    if (wheelDelta !== 0) {
      realParts.push(`[DesktopCtl.MouseNative]::mouse_event(0x0800,0,0,${wheelDelta},[UIntPtr]::Zero)`)
    }
    if (hWheelDelta !== 0) {
      realParts.push(`[DesktopCtl.MouseNative]::mouse_event(0x1000,0,0,${hWheelDelta},[UIntPtr]::Zero)`)
    }
    return this.runMouse(nativeHandle, options.x, options.y, mode, vParts.join('\n'), realParts.join('\n'))
  }

  // [SCREENSHOT]
  // 用 PrintWindow 抓取窗口（flag 2 对 DWM 渲染窗口更稳），再裁切到「客户区」，
  // 使截图原点与鼠标/快照所用的客户区坐标一致（否则模型按截图像素点击会偏移一个标题栏高度）。
  async screenshot(nativeHandle: string): Promise<ScreenshotResult> {
    const outPath = join(tmpdir(), `${tmpName('desktop-shot')}-${randomUUID()}.png`)
    const script = [
      `$hwnd = [IntPtr]::new([int64]${psQuote(nativeHandle)})`,
      'Add-Type -MemberDefinition @"',
      '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
      '[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);',
      '[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);',
      '[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);',
      'public struct RECT { public int Left, Top, Right, Bottom; }',
      'public struct POINT { public int X; public int Y; }',
      '"@ -Name Win -Namespace Native -UsingNamespace System.Drawing',
      '$wr = New-Object "Native.Win+RECT"',
      '[void][Native.Win]::GetWindowRect($hwnd, [ref]$wr)',
      '$ww = $wr.Right - $wr.Left; $wh = $wr.Bottom - $wr.Top',
      'if ($ww -le 0 -or $wh -le 0) { throw "窗口尺寸无效，可能已最小化" }',
      '$cr = New-Object "Native.Win+RECT"',
      '[void][Native.Win]::GetClientRect($hwnd, [ref]$cr)',
      '$cw = $cr.Right - $cr.Left; $ch = $cr.Bottom - $cr.Top',
      '$origin = New-Object "Native.Win+POINT"; $origin.X = 0; $origin.Y = 0',
      '[void][Native.Win]::ClientToScreen($hwnd, [ref]$origin)',
      '$offX = $origin.X - $wr.Left; $offY = $origin.Y - $wr.Top',
      '$full = New-Object System.Drawing.Bitmap($ww, $wh)',
      '$g = [System.Drawing.Graphics]::FromImage($full)',
      '$dc = $g.GetHdc()',
      '[void][Native.Win]::PrintWindow($hwnd, $dc, 2)',
      '$g.ReleaseHdc($dc); $g.Dispose()',
      // 客户区无效时退回整窗，避免崩溃。
      'if ($cw -le 0 -or $ch -le 0) { $cw = $ww; $ch = $wh; $offX = 0; $offY = 0 }',
      '$crop = New-Object System.Drawing.Bitmap($cw, $ch)',
      '$cg = [System.Drawing.Graphics]::FromImage($crop)',
      '$srcRect = New-Object System.Drawing.Rectangle($offX, $offY, $cw, $ch)',
      '$cg.DrawImage($full, (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)), $srcRect, [System.Drawing.GraphicsUnit]::Pixel)',
      '$cg.Dispose()',
      `$crop.Save(${psQuote(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$crop.Dispose(); $full.Dispose()',
      '"ok"'
    ].join('\n')
    await runPowerShell(script, 20_000)
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
    if (!pid && target.nativeHandle) {
      const win = await this.findWindow({ nativeHandle: target.nativeHandle })
      pid = win?.processId
    }
    if (!pid) return { ok: false, message: '未提供有效的进程或窗口' }
    const script = force
      ? `Stop-Process -Id ${pid} -Force; "ok"`
      : [
          `$p = Get-Process -Id ${pid} -ErrorAction Stop`,
          '$null = $p.CloseMainWindow()',
          'Start-Sleep -Milliseconds 500',
          `if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { "ok-graceful" } else { "still-running" }`
        ].join('\n')
    const out = await runPowerShell(script, 15_000)
    return { ok: true, message: out }
  }
}
