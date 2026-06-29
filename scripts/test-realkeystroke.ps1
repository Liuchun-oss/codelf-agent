# 端到端验证 realKeystroke：开记事本 -> 逐字符真实键入"我爱你" -> 读回内容。
# 本次保留记事本窗口不关闭，方便肉眼确认。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DpiCtl {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static void Apply() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}
    try { SetProcessDPIAware(); } catch {}
  }
}
"@
try { [DpiCtl]::Apply() } catch {}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# 复刻 windows.ts 的 SendInput 封装（逐字符 KEYEVENTF_UNICODE）。
Add-Type -MemberDefinition @"
[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
[DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inp, int size);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
static void Send(ushort vk, ushort scan, uint flags) { var a = new INPUT[1]; a[0].type = 1; a[0].u.ki.wVk = vk; a[0].u.ki.wScan = scan; a[0].u.ki.dwFlags = flags; SendInput(1, a, Marshal.SizeOf(typeof(INPUT))); }
public static void TapUnicode(ushort ch) { Send(0, ch, 0x0004); Send(0, ch, 0x0004 | 0x0002); }
public static void Fg(IntPtr h) { SetForegroundWindow(h); }
"@ -Name SendInputNative -Namespace DesktopCtl

$null = Start-Process notepad
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 300
  $np = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($np) { $hwnd = $np.MainWindowHandle; break }
}
if ($hwnd -eq [IntPtr]::Zero) { throw "Notepad 窗口句柄获取失败" }
[DesktopCtl.SendInputNative]::Fg($hwnd)
Start-Sleep -Milliseconds 400

# 定位编辑区控件。
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
$edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if ($null -eq $edit) {
  $cond2 = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
  $edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond2)
}
try { $edit.SetFocus() } catch {}
Start-Sleep -Milliseconds 250

# 用码点构造"我爱你"，避免 .ps1 文件编码导致中文字面量被读乱。
$text = [string]::Concat([char]0x6211, [char]0x7231, [char]0x4F60)
foreach ($c in $text.ToCharArray()) {
  [DesktopCtl.SendInputNative]::TapUnicode([uint16][char]$c)
  Start-Sleep -Milliseconds 60
}
Start-Sleep -Milliseconds 400

$readback = ""
try {
  $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $readback = $vp.Current.Value
} catch {}

$ok = $readback.Contains($text)
Write-Host ("RESULT " + $(if ($ok) { "PASS" } else { "FAIL" }))
Write-Host ("typed   : " + $text)
Write-Host ("readback: " + $readback)
Write-Host "Notepad window kept open for visual check."
