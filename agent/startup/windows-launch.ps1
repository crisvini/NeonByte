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
& $NodePath "--env-file-if-exists=$root/.env" "$root/agent/dist/main.js" run *>> $log
exit $LASTEXITCODE
