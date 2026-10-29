param([string]$Script, [string]$Scenario)
$ErrorActionPreference = 'Stop'
$base = Join-Path ([IO.Path]::GetTempPath()) ('neonbyte-update-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force (Join-Path $base 'scripts'), (Join-Path $base 'agent\startup') | Out-Null
Copy-Item $Script (Join-Path $base 'scripts\update-and-restart.ps1')
$global:testEvents = [Collections.Generic.List[string]]::new()
$global:testRunning = $true
function Get-Command {
    if ($args[0] -in @('git.exe', 'node.exe', 'npm.cmd')) { return [pscustomobject]@{ Name = $args[0] } }
    Microsoft.PowerShell.Core\Get-Command @args
}
function Get-ScheduledTask {
    if ($Scenario -eq 'missing-task') { throw 'Task missing' }
    $path = Join-Path $base 'agent\startup\windows-hidden.vbs'
    if ($Scenario -eq 'wrong-task') { $path = 'C:\other\agent\startup\windows-hidden.vbs' }
    [pscustomobject]@{ TaskName = 'NeonByte Agent'; TaskPath = '\'; State = $(if ($global:testRunning) { 'Running' } else { 'Ready' }); Actions = @([pscustomobject]@{ Execute = "$env:SystemRoot\System32\wscript.exe"; Arguments = "//B //NoLogo `"$path`" `"C:\node.exe`"" }) }
}
function Stop-ScheduledTask { $global:testEvents.Add('stop'); $global:testRunning = $false }
function Stop-Process { throw 'A test must never stop a real process.' }
function Start-ScheduledTask { $global:testEvents.Add('start'); $global:testRunning = $true }
function Get-CimInstance {
    [pscustomobject]@{ ProcessId = 12345; Name = 'node.exe'; CommandLine = '"C:\node.exe" "C:\other\agent\dist\main.js" run' }
    if ($global:testRunning) { [pscustomobject]@{ ProcessId = 43210; Name = 'node.exe'; CommandLine = '"C:\node.exe" "' + (Join-Path $base 'agent\dist\main.js') + '" run' } }
}
function Get-NetTCPConnection { if ($global:testRunning) { [pscustomobject]@{ OwningProcess = 43210 } } }
function Invoke-WebRequest { [pscustomobject]@{ StatusCode = 200 } }
function git {
    $operation = $args -join ' '
    if ($operation -match 'ls-files -v') { if ($Scenario -eq 'hidden-changes') { 'S hidden.txt' }; $global:LASTEXITCODE = 0; return }
    if ($operation -match 'status --porcelain') { if ($Scenario -eq 'dirty') { '?? secret.txt' }; $global:LASTEXITCODE = 0; return }
    if ($operation -match 'rev-parse --abbrev-ref HEAD') { 'main'; $global:LASTEXITCODE = 0; return }
    if ($operation -match 'rev-parse') { '0123456789abcdef0123456789abcdef01234567'; $global:LASTEXITCODE = 0; return }
    if ($operation -match 'merge-base') { $global:LASTEXITCODE = if ($Scenario -eq 'diverged') { 1 } else { 0 }; return }
    $global:LASTEXITCODE = 0
}
function npm.cmd {
    $operation = $args -join ' '
    $global:testEvents.Add("npm $operation")
    $global:LASTEXITCODE = if ($Scenario -eq 'build-fails' -and $operation -match 'run build') { 1 } else { 0 }
}
try {
    Set-Location $base
    & (Join-Path $base 'scripts\update-and-restart.ps1')
    $result = $global:LASTEXITCODE
    $events = $global:testEvents -join ','
    if ($Scenario -eq 'success') {
        if ($result -ne 0 -or $events -notmatch 'stop,.*npm .*run build,start') { throw "Success scenario failed: $result / $events" }
    } elseif ($Scenario -eq 'build-fails') {
        if ($result -eq 0 -or $events -notmatch 'stop' -or $events -match 'start') { throw "Build failure safety failed: $result / $events" }
    } elseif ($result -eq 0 -or $events -match 'stop|start|npm') { throw "Preflight safety failed: $result / $events" }
    Write-Output "PASS $Scenario"
} finally {
    Set-Location $env:TEMP
    Remove-Item -Recurse -Force $base
}
