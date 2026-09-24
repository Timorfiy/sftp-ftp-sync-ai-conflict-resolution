param(
  [Parameter(Mandatory=$true)][int]$EditorPid,
  [Parameter(Mandatory=$true)][string]$ExtensionPath
)
$ErrorActionPreference = 'Stop'
$all = @(Get-CimInstance Win32_Process)
$editor = $all | Where-Object { $_.ProcessId -eq $EditorPid }
if (-not $editor -or -not $editor.CommandLine.Contains('--user-data-dir') -or
    -not $editor.CommandLine.Contains('--extensions-dir')) { throw 'Not an isolated editor process' }
$owned = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$owned.Add($EditorPid)
do {
  $added = $false
  foreach ($process in $all) {
    if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) { $added=$true }
  }
} while ($added)
$entry = Join-Path $ExtensionPath 'dist\mcp-server.js'
$candidates = @($all | Where-Object {
  $owned.Contains([int]$_.ProcessId) -and $_.CommandLine -and
  $_.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $_.ExecutablePath -eq $editor.ExecutablePath
})
if ($candidates.Count -ne 1) { throw 'Expected exactly one owned editor-launched packaged MCP server' }
Add-Type -Path (Join-Path $PSScriptRoot 'McpEnvironment.cs')
$configuration = [RcMcpEnvironment]::Configuration([int]$candidates[0].ProcessId)
# Captured by Node over a private pipe. Never write or display this output.
@{command=$candidates[0].ExecutablePath; args=@($entry); configuration=$configuration;
  pid=[int]$candidates[0].ProcessId} | ConvertTo-Json -Compress
