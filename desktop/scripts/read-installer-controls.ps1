# Enumerate the Win32 child controls of a running installer window and dump them as UTF-8 JSON.
#
# WHY WIN32 AND NOT UI AUTOMATION. The first attempt used UI Automation and it returned the window
# and nothing else: NSIS builds its pages from plain Win32 STATIC/BUTTON controls, and the UIA view
# it exposes over them is too thin to carry the button captions. `EnumChildWindows` plus
# `GetWindowTextW` reads the same captions the user sees, which is the only evidence that matters
# for the question "is this installer in Spanish?".
#
# WHY JSON AND NOT CONSOLE OUTPUT. PowerShell 5.1 writes to the console in the OEM code page, so
# "Instalación" arrives as mojibake in a captured log. A gate that then greps for `Instalación`
# fails against an installer that is perfectly Spanish. JSON written with an explicit UTF-8 encoder
# is read back by the Node parent as UTF-8, with no console in the path. The console echo is kept
# for humans and is explicitly NOT what the gate reads.
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [string]$Out = ""
)

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class W32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);

  public static List<IntPtr> Children(IntPtr parent) {
    var list = new List<IntPtr>();
    EnumChildWindows(parent, (h, l) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Text(IntPtr h) { var sb = new StringBuilder(1024); GetWindowTextW(h, sb, 1024); return sb.ToString(); }
  public static string Cls(IntPtr h)  { var sb = new StringBuilder(256);  GetClassNameW(h, sb, 256);  return sb.ToString(); }
}
"@

$proc = Get-Process -Id $ProcessId -ErrorAction Stop
$proc.Refresh()
$h = $proc.MainWindowHandle
if ($h -eq 0) { Write-Output "no main window"; exit 1 }
[void][W32]::SetForegroundWindow($h)
[void][W32]::BringWindowToTop($h)
Start-Sleep -Milliseconds 400

$items = @()
foreach ($c in [W32]::Children($h)) {
  $r = New-Object W32+RECT
  [void][W32]::GetWindowRect($c, [ref]$r)
  $items += [pscustomobject]@{
    id       = [W32]::GetDlgCtrlID($c)
    cls      = [W32]::Cls($c)
    text     = [W32]::Text($c)
    visible  = [W32]::IsWindowVisible($c)
    enabled  = [W32]::IsWindowEnabled($c)
    width    = ($r.Right - $r.Left)
    height   = ($r.Bottom - $r.Top)
  }
}

$target = if ($Out) { $Out } else { Join-Path $env:TEMP "installer-controls.json" }
$json = [pscustomobject]@{
  pid      = $ProcessId
  title    = $proc.MainWindowTitle
  controls = $items
} | ConvertTo-Json -Depth 5

# Explicit UTF-8 WITHOUT a BOM. `Out-File -Encoding utf8` in PowerShell 5.1 writes a BOM, and a BOM
# turns the first JSON key into "﻿{" as far as a naive parser is concerned.
[System.IO.File]::WriteAllText($target, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output $target
