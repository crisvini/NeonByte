param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$logDir = Join-Path $env:LOCALAPPDATA 'NeonByte'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'agent.log'
if ((Test-Path $log) -and (Get-Item $log).Length -gt 1048576) {
    Move-Item -Force $log (Join-Path $logDir 'agent.previous.log')
}
Set-Location $root
$nodeArguments = @()
$envFile = Join-Path $root '.env'
if (Test-Path -LiteralPath $envFile) { $nodeArguments += "--env-file=$envFile" }
$nodeArguments += (Join-Path $root 'agent/dist/main.js'), 'run'
# Windows PowerShell 5.1 treats redirected native stderr as an error record.
$ErrorActionPreference = 'Continue'
& $NodePath @nodeArguments *>> $log
exit $LASTEXITCODE
