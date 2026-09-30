# Report the title of the visible top-level window owned by a given process, as UTF-8 JSON.
#
# WHY THIS EXISTS. `verify-installed-e2e.mjs` asserted the installed app "launched" by looking for
# a `MiniMarck.exe` process. A process proves a binary started; it does not prove a shop got a
# window with a title on it. A window that never paints, or an app that opens on the wrong screen,
# both leave four healthy processes behind — which is exactly what happened the first time this
# check was written by hand: the process test passed while a title search found nothing, and the
# only reason there was eventually a title is that the window appeared later than the assertion
# looked for it. So the title is read, and read with a real window enumeration, not inferred.
#
# WHY JSON AND NOT CONSOLE OUTPUT. PowerShell 5.1 writes to the console in the OEM code page, so a
# title with an accent arrives as mojibake in a captured log, and a gate that then greps for it
# fails against a perfectly correct window. JSON written with an explicit UTF-8 encoder is read back
# by the Node parent as UTF-8, with no console in the path.
#
# The window is looked up by PROCESS rather than by title, because the title is the thing under
# test: searching for "MiniMarck" in the title to then report the title would assert nothing.
param(
  [Parameter(Mandatory = $true)][string]$ProcessName,
  [int]$TimeoutSeconds = 90,
  [string]$Out = ""
)

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class TitleW32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$result = [ordered]@{ title = $null; visible = $false; width = 0; height = 0; waitedSeconds = 0 }

while ((Get-Date) -lt $deadline) {
  $pids = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  if ($pids.Count -gt 0) {
    $script:found = $null
    $cb = [TitleW32+EnumProc]{
      param($h, $l)
      $owner = 0
      [void][TitleW32]::GetWindowThreadProcessId($h, [ref]$owner)
      if ($pids -contains [int]$owner -and [TitleW32]::IsWindowVisible($h)) {
        $sb = New-Object System.Text.StringBuilder 1024
        [void][TitleW32]::GetWindowTextW($h, $sb, 1024)
        if ($sb.Length -gt 0) {
          $rect = New-Object TitleW32+RECT
          [void][TitleW32]::GetWindowRect($h, [ref]$rect)
          $script:found = [ordered]@{
            title = $sb.ToString()
            visible = [TitleW32]::IsWindowVisible($h)
            width = $rect.Right - $rect.Left
            height = $rect.Bottom - $rect.Top
          }
        }
      }
      return $true
    }
    [void][TitleW32]::EnumWindows($cb, [IntPtr]::Zero)
    if ($script:found) {
      $result = $script:found
      break
    }
  }
  Start-Sleep -Milliseconds 1500
}

$result.waitedSeconds = [int]($TimeoutSeconds - ($deadline - (Get-Date)).TotalSeconds)

$json = $result | ConvertTo-Json -Compress
$enc = New-Object System.Text.UTF8Encoding $false
if ($Out) { [System.IO.File]::WriteAllText($Out, $json, $enc) }
Write-Output $json
