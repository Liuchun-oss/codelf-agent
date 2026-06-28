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
  type KeyComboOptions,
  type LaunchResult,
  type MouseClickOptions,
  type MouseDragOptions,
  type MouseMoveOptions,
  type MouseScrollOptions,
  type ScreenshotOptions,
  type ScreenshotResult,
  type SnapshotResult,
  type UiNode,
  type WindowInfo
} from './index'

// 让本辅助进程声明 per-monitor DPI 感知，必须在加载 WinForms / 调用任何窗口坐标 API 之前执行，
// 否则在非 100% 缩放（如 150%）下，GetClientRect/ClientToScreen/PrintWindow 会按「被系统虚拟化」的
// 逻辑像素工作，导致截图尺寸、scale 换算与鼠标注入坐标整体差一个缩放因子（点击偏移）。
// 多级回退：PerMonitorV2(-4) → PerMonitor(-3)（Win10 1703+）→ SetProcessDpiAwareness(2)（Win8.1+）
// → SetProcessDPIAware()（Vista+）。
const PS_DPI_AWARE = [
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class DpiCtl {',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);',
  '  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '  public static void Apply() {',
  '    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}',
  '    try { if (SetProcessDpiAwarenessContext(new IntPtr(-3))) return; } catch {}',
  '    try { SetProcessDpiAwareness(2); return; } catch {}',
  '    try { SetProcessDPIAware(); } catch {}',
  '  }',
  '}',
  '"@',
  'try { [DpiCtl]::Apply() } catch {}'
].join('\n')

const PS_PREAMBLE = [
  '$ErrorActionPreference = "Stop"',
  '$ProgressPreference = "SilentlyContinue"',
  PS_DPI_AWARE,
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
      '$queue.Enqueue(@{ el = $root; d = 0 })',
      '$idx = 0',
      '$truncated = $false',
      'while ($queue.Count -gt 0) {',
      '  if ($nodes.Count -ge $max) { $truncated = $true; break }',
      '  $item = $queue.Dequeue()',
      '  $el = $item.el; $depth = $item.d',
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
      '      $aid = ""; try { $aid = $el.Current.AutomationId } catch {}',
      '      $enabled = $true; try { $enabled = $el.Current.IsEnabled } catch {}',
      // AutomationId 稳定且语义化，存在时 ref 用 "a:<id>"（定位可一步命中）；否则回退遍历序号 "n<idx>"。
      '      $ref = if ($aid -ne "") { "a:$aid" } else { "n$cur" }',
      '      [void]$nodes.Add(@{ ref = $ref; role = $ct; name = $name; actionable = $actionable; editable = $editable; enabled = $enabled; automationId = $aid; depth = $depth; bounds = @{ x=[int]$r.X; y=[int]$r.Y; width=[int]$r.Width; height=[int]$r.Height }; center = @{ x=[int]$cp.X; y=[int]$cp.Y } })',
      '    }',
      '  } catch {}',
      '  try {',
      '    $child = $walker.GetFirstChild($el)',
      '    while ($null -ne $child) { $queue.Enqueue(@{ el = $child; d = $depth + 1 }); $child = $walker.GetNextSibling($child) }',
      '  } catch {}',
      '}',
      // 抽取高频上下文：焦点元素、选中文本、焦点文档正文。任一失败都忽略，不影响节点列表。
      '$focused = ""; $seltext = ""; $doctext = ""',
      'try {',
      '  $fe = [System.Windows.Automation.AutomationElement]::FocusedElement',
      '  if ($null -ne $fe) {',
      '    $fct = $fe.Current.ControlType.ProgrammaticName -replace "ControlType.",""',
      '    $focused = ("{0} ""{1}""" -f $fct, $fe.Current.Name)',
      '    try { $tp = $fe.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern); $sel = $tp.GetSelection(); if ($sel.Length -gt 0) { $seltext = $sel[0].GetText(4096) } } catch {}',
      '    try { $vp = $fe.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $doctext = $vp.Current.Value } catch {}',
      '    if ($doctext -eq "") { try { $tp2 = $fe.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern); $doctext = $tp2.DocumentRange.GetText(8192) } catch {} }',
      '  }',
      '} catch {}',
      'ConvertTo-Json -Compress -Depth 5 -InputObject @{ nodes = @($nodes); truncated = $truncated; focusedElement = $focused; selectedText = $seltext; documentText = $doctext }'
    ].join('\n')
    const raw = await runPowerShell(script, 30_000)
    const parsed = JSON.parse(raw) as {
      nodes: UiNode[]
      truncated: boolean
      focusedElement?: string
      selectedText?: string
      documentText?: string
    }
    return {
      nodes: parsed.nodes ?? [],
      truncated: !!parsed.truncated,
      focusedElement: parsed.focusedElement || undefined,
      selectedText: parsed.selectedText || undefined,
      documentText: parsed.documentText || undefined
    }
  }

  // [CLICK_TYPE]
  // 按 ref 定位目标元素，结果放入 $target。两种 ref：
  // - "a:<AutomationId>"：用 PropertyCondition 一步查找（稳定，不依赖遍历顺序）；
  // - "n<idx>"：回退按 ControlView 广度遍历序号定位（与 snapshot 同序）。
  private locateElementScript(nativeHandle: string, ref: string): string {
    const head = [
      `$hwnd = [IntPtr]::new([int64]${psQuote(nativeHandle)})`,
      '$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)',
      'if ($null -eq $root) { throw "无法从句柄获取窗口元素" }',
      '$target = $null'
    ]
    if (ref.startsWith('a:')) {
      const aid = ref.slice(2)
      return [
        ...head,
        `$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, ${psQuote(aid)})`,
        '$target = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)',
        'if ($null -eq $target) { throw "未找到 AutomationId 对应的控件，请重新 DesktopSnapshot" }'
      ].join('\n')
    }
    const targetIdx = ref.replace(/^n/, '')
    return [
      ...head,
      '$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
      '$queue = New-Object System.Collections.Queue',
      '$queue.Enqueue($root)',
      '$idx = 0',
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
      // 优先用无障碍 pattern，按覆盖面从常用到兜底逐个尝试；全失败才降级坐标点击。
      'try { $target.SetFocus() } catch {}',
      '$done = $null',
      // 1) Invoke：按钮、链接等可调用控件。
      'if ($null -eq $done) { try { $p = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $p.Invoke(); $done = "ok-invoke" } catch {} }',
      // 2) Toggle：复选框、开关。
      'if ($null -eq $done) { try { $p = $target.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $p.Toggle(); $done = "ok-toggle" } catch {} }',
      // 3) SelectionItem：列表项、下拉项、单选按钮、选项卡。
      'if ($null -eq $done) { try { $p = $target.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $p.Select(); $done = "ok-select" } catch {} }',
      // 4) ExpandCollapse：树节点、组合框、展开菜单。
      'if ($null -eq $done) { try { $p = $target.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern); if ($p.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) { $p.Expand() } else { $p.Collapse() }; $done = "ok-expand" } catch {} }',
      // 5) LegacyIAccessible：老式 MSAA 控件的默认动作。
      'if ($null -eq $done) { try { $p = $target.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern); $p.DoDefaultAction(); $done = "ok-legacy" } catch {} }',
      // 6) 坐标兜底：移动真实光标到控件中心并点击（无 pattern 时的最后手段）。
      'if ($null -eq $done) {',
      '  $r = $target.Current.BoundingRectangle',
      '  $cx = [int]($r.X + $r.Width/2); $cy = [int]($r.Y + $r.Height/2)',
      '  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($cx, $cy)',
      '  Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);\' -Name M -Namespace W',
      '  [W.M]::mouse_event(0x02,0,0,0,0); [W.M]::mouse_event(0x04,0,0,0,0); $done = "ok-coord"',
      '}',
      '$done'
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
      '[DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);',
      '[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);',
      '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
      '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, UIntPtr extra);',
      '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
      'public struct POINT { public int X; public int Y; }',
      '"@ -Name MouseNative -Namespace DesktopCtl'
    ].join('\n')
  }

  // 子窗口解析（仅虚拟模式用）：把顶层客户区坐标 ($cx,$cy) 经屏幕坐标命中真正的子窗口，
  // 得到目标句柄 $thwnd 与该子窗口客户区坐标 ($tcx,$tcy) 及其打包 lParam $clp。
  // 这样消息能投递到坐标下的实际控件，而非一律发给顶层窗口（后者对很多复杂界面无效）。
  // 同时定义 _pk 用于运行时打包任意子窗口客户区坐标。
  private childResolveLines(): string {
    return [
      'function _pk($x,$y) { return [IntPtr](((([int]$y) -band 0xffff) -shl 16) -bor (([int]$x) -band 0xffff)) }',
      '$gp = New-Object DesktopCtl.MouseNative+POINT; $gp.X = $cx; $gp.Y = $cy',
      '[void][DesktopCtl.MouseNative]::ClientToScreen($hwnd, [ref]$gp)',
      '$thwnd = [DesktopCtl.MouseNative]::WindowFromPoint($gp)',
      'if ($thwnd -eq [IntPtr]::Zero) { $thwnd = $hwnd }',
      '$tp = New-Object DesktopCtl.MouseNative+POINT; $tp.X = $gp.X; $tp.Y = $gp.Y',
      '[void][DesktopCtl.MouseNative]::ScreenToClient($thwnd, [ref]$tp)',
      '$tcx = $tp.X; $tcy = $tp.Y',
      '$clp = _pk $tcx $tcy'
    ].join('\n')
  }

  // 鼠标按键的 wParam 标志位（MK_LBUTTON 等）。
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
  // 虚拟模式先解析坐标下的真实子窗口（$thwnd）并提供 _mt 把顶层客户区坐标映射到子窗口
  // 客户区的打包 lParam，使消息投递到实际控件而非一律发给顶层窗口。
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
      useReal ? '' : this.childResolveLines(),
      useReal ? realBody : virtualBody,
      useReal ? '"ok-real"' : '"ok-virtual"'
    ]
      .filter(Boolean)
      .join('\n')
    const out = await runPowerShell(script, 15_000)
    return { ok: true, message: out }
  }

  async mouseClick(nativeHandle: string, options: MouseClickOptions): Promise<DriverActionResult> {
    const button = options.button ?? 'left'
    const mode = options.mode ?? 'auto'
    const dbl = options.doubleClick ?? false
    const msgs = this.buttonMsgs(button)
    const mk = this.buttonMk(button)
    // 虚拟模式：投递到坐标命中的子窗口 $thwnd，坐标用运行时换算的 $clp（子窗口客户区）。
    const post = (msg: number, w: string) =>
      `[void][DesktopCtl.MouseNative]::PostMessage($thwnd, ${msg}, [IntPtr]${w}, $clp)`
    const virtualBody = [
      post(0x0200, '0'),
      post(msgs.down, String(mk)),
      post(msgs.up, '0'),
      dbl ? post(msgs.dbl, String(mk)) : '',
      dbl ? post(msgs.up, '0') : ''
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
    const virtualBody = `[void][DesktopCtl.MouseNative]::PostMessage($thwnd, 0x0200, [IntPtr]0, $clp)`
    const realBody = this.realMoveLines().join('\n')
    return this.runMouse(nativeHandle, options.x, options.y, mode, virtualBody, realBody)
  }

  async mouseDrag(nativeHandle: string, options: MouseDragOptions): Promise<DriverActionResult> {
    const button = options.button ?? 'left'
    const mode = options.mode ?? 'auto'
    const steps = Math.max(2, Math.min(options.steps ?? 20, 200))
    const msgs = this.buttonMsgs(button)
    const mk = this.buttonMk(button)
    // 虚拟模式：以起点解析出的子窗口 $thwnd 为目标，中间点用相对起点的偏移在子窗口客户区内推算
    // （客户区与屏幕同尺度，偏移量可直接复用），逐帧投递 WM_MOUSEMOVE。
    const moves: string[] = []
    for (let i = 1; i <= steps; i++) {
      const dx = Math.round(((options.toX - options.fromX) * i) / steps)
      const dy = Math.round(((options.toY - options.fromY) * i) / steps)
      moves.push(
        `[void][DesktopCtl.MouseNative]::PostMessage($thwnd, 0x0200, [IntPtr]${mk}, (_pk ($tcx + ${dx}) ($tcy + ${dy}))); Start-Sleep -Milliseconds 10`
      )
    }
    const endDx = Math.round(options.toX - options.fromX)
    const endDy = Math.round(options.toY - options.fromY)
    const virtualBody = [
      `[void][DesktopCtl.MouseNative]::PostMessage($thwnd, 0x0200, [IntPtr]0, $clp)`,
      `[void][DesktopCtl.MouseNative]::PostMessage($thwnd, ${msgs.down}, [IntPtr]${mk}, $clp)`,
      ...moves,
      `[void][DesktopCtl.MouseNative]::PostMessage($thwnd, ${msgs.up}, [IntPtr]0, (_pk ($tcx + ${endDx}) ($tcy + ${endDy})))`
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
    // WM_MOUSEWHEEL/HWHEEL：lParam 为屏幕坐标（$gp 已由 childResolveLines 换算好）；
    // 消息投递给坐标命中的子窗口 $thwnd。
    const screenLp = '$slp = _pk $gp.X $gp.Y'
    const vParts: string[] = [`[void][DesktopCtl.MouseNative]::PostMessage($thwnd, 0x0200, [IntPtr]0, $clp)`, screenLp]
    if (wheelDelta !== 0) {
      vParts.push(`[void][DesktopCtl.MouseNative]::PostMessage($thwnd, 0x020a, [IntPtr]${(wheelDelta << 16) | 0}, $slp)`)
    }
    if (hWheelDelta !== 0) {
      vParts.push(`[void][DesktopCtl.MouseNative]::PostMessage($thwnd, 0x020e, [IntPtr]${(hWheelDelta << 16) | 0}, $slp)`)
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

  // [KEYS]
  // 把通用组合键（如 "ctrl+shift+esc"）转成 SendKeys 语法：
  // 修饰键 ctrl=^ alt=% shift=+；特殊键裹大括号 {ENTER}/{TAB}/{F5}…；普通字符原样。
  private static SENDKEYS_SPECIAL: Record<string, string> = {
    enter: '{ENTER}', return: '{ENTER}', esc: '{ESC}', escape: '{ESC}', tab: '{TAB}',
    space: ' ', backspace: '{BACKSPACE}', bs: '{BACKSPACE}', del: '{DELETE}', delete: '{DELETE}',
    home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', insert: '{INSERT}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
    f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}'
  }

  private static comboToSendKeys(combo: string): string {
    const parts = combo.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean)
    let prefix = ''
    let key = ''
    for (const p of parts) {
      if (p === 'ctrl' || p === 'control') prefix += '^'
      else if (p === 'alt') prefix += '%'
      else if (p === 'shift') prefix += '+'
      else if (p === 'win' || p === 'super' || p === 'cmd' || p === 'meta') {
        // SendKeys 无 Win 键；交给调用方降级，这里忽略修饰但仍发送主键。
      } else {
        const mapped = WindowsDesktopDriver.SENDKEYS_SPECIAL[p]
        key = mapped ?? p.replace(/([+^%~(){}[\]])/g, '{$1}')
      }
    }
    return prefix + key
  }

  async pressKeys(nativeHandle: string, options: KeyComboOptions): Promise<DriverActionResult> {
    const sk = WindowsDesktopDriver.comboToSendKeys(options.combo)
    if (!sk) return { ok: false, message: `无法解析组合键：${options.combo}` }
    const script = [
      `$hwnd = [IntPtr]::new([int64]${psQuote(nativeHandle)})`,
      'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);\' -Name KF -Namespace DesktopCtl',
      '[void][DesktopCtl.KF]::SetForegroundWindow($hwnd)',
      'Start-Sleep -Milliseconds 60',
      `[System.Windows.Forms.SendKeys]::SendWait(${psQuote(sk)})`,
      '"ok"'
    ].join('\n')
    const out = await runPowerShell(script, 15_000)
    return { ok: true, message: out }
  }

  // [SCREENSHOT]
  // 用 PrintWindow 抓取窗口（flag 2 对 DWM 渲染窗口更稳），再裁切到「客户区」，
  // 使截图原点与鼠标/快照所用的客户区坐标一致（否则模型按截图像素点击会偏移一个标题栏高度）。
  // 可选 maxDimension：最长边超过它时等比缩小，压低视觉 token 成本，并回报缩放系数。
  async screenshot(nativeHandle: string, options?: ScreenshotOptions): Promise<ScreenshotResult> {
    const outPath = join(tmpdir(), `${tmpName('desktop-shot')}-${randomUUID()}.png`)
    const maxDim = options?.maxDimension && options.maxDimension > 0 ? Math.round(options.maxDimension) : 0
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
      // 可选等比缩放：最长边裁到 $maxDim。
      `$maxDim = ${maxDim}`,
      '$imgW = $cw; $imgH = $ch',
      '$longest = [Math]::Max($cw, $ch)',
      'if ($maxDim -gt 0 -and $longest -gt $maxDim) {',
      '  $ratio = $maxDim / $longest',
      '  $imgW = [Math]::Max(1, [int]($cw * $ratio)); $imgH = [Math]::Max(1, [int]($ch * $ratio))',
      '  $scaled = New-Object System.Drawing.Bitmap($imgW, $imgH)',
      '  $sg = [System.Drawing.Graphics]::FromImage($scaled)',
      '  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
      '  $sg.DrawImage($crop, 0, 0, $imgW, $imgH)',
      '  $sg.Dispose(); $crop.Dispose(); $crop = $scaled',
      '}',
      `$crop.Save(${psQuote(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$crop.Dispose(); $full.Dispose()',
      '@{ clientWidth = $cw; clientHeight = $ch; imageWidth = $imgW; imageHeight = $imgH } | ConvertTo-Json -Compress'
    ].join('\n')
    const raw = await runPowerShell(script, 20_000)
    const dims = JSON.parse(raw) as { clientWidth: number; clientHeight: number; imageWidth: number; imageHeight: number }
    try {
      const buffer = await readFile(outPath)
      const scale = dims.clientWidth > 0 ? dims.imageWidth / dims.clientWidth : 1
      return {
        buffer,
        mime: 'image/png',
        imageWidth: dims.imageWidth,
        imageHeight: dims.imageHeight,
        clientWidth: dims.clientWidth,
        clientHeight: dims.clientHeight,
        scale
      }
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
