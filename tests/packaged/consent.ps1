# Answers the recording consent dialog the way its own buttons do: ticks "I have permission to
# record this content" and presses "Start recording". The dialog is native on purpose (web pages
# can't fake or skip it), so the packaged check has no other way past it.
#
# It is a Windows task dialog, which takes those two actions as messages sent to its window
# (TDM_CLICK_VERIFICATION, TDM_CLICK_BUTTON): no mouse, no keyboard and no focus, so nothing
# reaches any other window, even when the dialog is behind them. Only the dialog of the app under
# test is touched: the one whose main process was started with the test's profile ($Profile).
# Exits 0 once the dialog has closed after being answered, 1 otherwise.
param([Parameter(Mandatory = $true)][string]$Profile, [int]$TimeoutSeconds = 30)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TaskDialogMessages {
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  const uint WM_USER = 0x0400;
  public static void TickVerification(IntPtr dialog) { SendMessage(dialog, WM_USER + 113, (IntPtr)1, IntPtr.Zero); }
  public static void PressButton(IntPtr dialog, int id) { SendMessage(dialog, WM_USER + 102, (IntPtr)id, IntPtr.Zero); }
}
'@
# Electron numbers a message box's own buttons from 100, in order: "Start recording" is the first.
$START_RECORDING = 100

$ae = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)

# The browser's main process for this profile (its helper processes have a --type).
$main = $null
while (-not $main -and (Get-Date) -lt $deadline) {
  $main = Get-CimInstance Win32_Process -Filter "Name = 'Simple Browser.exe'" |
    Where-Object { $_.CommandLine -like "*$Profile*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
  if (-not $main) { Start-Sleep -Milliseconds 300 }
}
if (-not $main) { Write-Output 'the app under test is not running'; exit 1 }

$dialogCondition = New-Object System.Windows.Automation.AndCondition(@(
  (New-Object System.Windows.Automation.PropertyCondition($ae::NameProperty, 'Record this page?')),
  (New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)),
  (New-Object System.Windows.Automation.PropertyCondition($ae::ProcessIdProperty, [int]$main.ProcessId))))

while ((Get-Date) -lt $deadline) {
  $dialog = $ae::RootElement.FindFirst($scope::Descendants, $dialogCondition)
  if ($dialog -and $dialog.Current.NativeWindowHandle -ne 0) {
    $handle = [IntPtr]$dialog.Current.NativeWindowHandle
    Start-Sleep -Milliseconds 300 # let it finish laying out
    [TaskDialogMessages]::TickVerification($handle)
    [TaskDialogMessages]::PressButton($handle, $START_RECORDING)
    for ($i = 0; $i -lt 20 -and [TaskDialogMessages]::IsWindow($handle); $i++) { Start-Sleep -Milliseconds 100 }
    if ([TaskDialogMessages]::IsWindow($handle)) { Write-Output 'the dialog did not close'; exit 1 }
    Write-Output 'consent given'
    exit 0
  }
  Start-Sleep -Milliseconds 300
}
Write-Output 'the consent dialog did not appear'
exit 1
