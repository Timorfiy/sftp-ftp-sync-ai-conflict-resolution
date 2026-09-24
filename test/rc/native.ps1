param(
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [ValidateSet('inspect','click','file','dismiss')][string]$Action = 'inspect',
  [string]$Button,
  [string]$File
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RcWindows {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, string text);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam,
    uint flags, uint timeout, out IntPtr result);
  public class Item { public long handle; public string name; public string type; public int controlId; }
  public static Item[] Children(int pid) {
    var items = new List<Item>();
    EnumWindows((top, unused) => {
      uint owner; GetWindowThreadProcessId(top, out owner);
      if(owner != pid) return true;
      EnumChildWindows(top, (child, parameter) => {
        var name = new StringBuilder(4096); var type = new StringBuilder(256);
        GetWindowText(child, name, name.Capacity); GetClassName(child, type, type.Capacity);
        if(type.ToString()=="Button" || type.ToString()=="Edit" || type.ToString()=="ComboBoxEx32")
          items.Add(new Item { handle=child.ToInt64(), name=name.ToString(), type="Native."+type.ToString(), controlId=GetDlgCtrlID(child) });
        return true;
      }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return items.ToArray();
  }
}
'@
$native = [RcWindows]::Children($ProcessId)
if ($Action -eq 'dismiss') {
  $cancel = $native | Where-Object { $_.type -eq 'Native.Button' -and $_.name.Replace('&','') -eq 'Cancel' } | Select-Object -First 1
  if (-not $cancel) { throw 'No owned native modal is available to dismiss' }
  $dialog = [RcWindows]::GetAncestor([IntPtr]$cancel.handle, 2)
  $class = New-Object Text.StringBuilder 256
  [void][RcWindows]::GetClassName($dialog, $class, 256)
  if ($class.ToString() -ne '#32770') { throw 'Refusing to dismiss anything except an owned native dialog' }
  [void][RcWindows]::PostMessage($dialog, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
  @{dismissed=$true} | ConvertTo-Json -Compress
  exit 0
}
if ($Action -eq 'file') {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf) -or [IO.Path]::GetExtension($File) -ne '.vsix') {
    throw 'Expected a local VSIX fixture'
  }
  $filename = $native | Where-Object { $_.type -eq 'Native.Edit' -and $_.controlId -eq 1148 } | Select-Object -First 1
  $open = $native | Where-Object { $_.type -eq 'Native.Button' -and $_.controlId -eq 1 } | Select-Object -First 1
  if (-not $filename -or -not $open) { throw 'Owned editor file dialog is not ready' }
  [void][RcWindows]::SendMessage([IntPtr]$filename.handle, 0xC, [IntPtr]::Zero, $File)
  $parent = [RcWindows]::GetParent([IntPtr]$open.handle)
  [void][RcWindows]::PostMessage($parent, 0x111, [IntPtr]1, [IntPtr]$open.handle)
  @{selected=$true; file=[IO.Path]::GetFileName($File)} | ConvertTo-Json -Compress
  exit 0
}
if ($Action -eq 'click') {
  $target = $native | Where-Object { $_.name.Replace('&','') -eq $Button } | Select-Object -First 1
  if ($target) {
    $handle = [IntPtr]$target.handle
    $dialog = [RcWindows]::GetAncestor($handle, 2)
    [void][RcWindows]::SetForegroundWindow($dialog)
    $result = [IntPtr]::Zero
    if ([RcWindows]::SendMessageTimeout($handle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero, 2, 3000, [ref]$result) -eq [IntPtr]::Zero) {
      throw 'Owned native button did not respond'
    }
    @{clicked=$true; button=$Button} | ConvertTo-Json -Compress
    exit 0
  }
}
$root = [Windows.Automation.AutomationElement]::RootElement
$condition = New-Object Windows.Automation.PropertyCondition(
  [Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId
)
$windows = $root.FindAll([Windows.Automation.TreeScope]::Children, $condition)
$output = @($native | ForEach-Object { @{type=$_.type; name=$_.name; id=$_.controlId} })
foreach ($window in $windows) {
  $elements = $window.FindAll(
    [Windows.Automation.TreeScope]::Descendants,
    [Windows.Automation.Condition]::TrueCondition
  )
  foreach ($element in $elements) {
    $type = $element.Current.ControlType.ProgrammaticName
    if ($type -eq 'ControlType.Button' -or $type -eq 'ControlType.Text') {
      $name = $element.Current.Name
      $output += @{type=$type; name=$name}
      if ($Action -eq 'click' -and $type -eq 'ControlType.Button' -and $name -eq $Button) {
        $invoke = $element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
        $invoke.Invoke()
        @{clicked=$true; button=$Button} | ConvertTo-Json -Compress
        exit 0
      }
    }
  }
}
if ($Action -eq 'click') { throw 'Requested native button is not visible in the owned editor process' }
ConvertTo-Json -InputObject @($output) -Compress
