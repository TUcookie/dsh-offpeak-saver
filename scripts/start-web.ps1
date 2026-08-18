param(
  [int]$Port = 3080
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:TEMP 'dsh-web-offpeak'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stdout = Join-Path $logDir "web-$Port.out.log"
$stderr = Join-Path $logDir "web-$Port.err.log"
Remove-Item -Force $stdout, $stderr -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath 'C:\Program Files\PowerShell\7\pwsh.exe' `
  -ArgumentList '-NoProfile', '-Command', "pnpm dlx @deepseek-ai/dsh web --port $Port" `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -PassThru

Write-Output "started pid=$($proc.Id) port=$Port"
Write-Output "log=$stdout"
