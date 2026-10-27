param([Parameter(Mandatory = $true)][string]$Launcher)
$ErrorActionPreference = 'Stop'
$base = Join-Path ([IO.Path]::GetTempPath()) ('neonbyte-test-' + [guid]::NewGuid())
$oldLocalAppData = $env:LOCALAPPDATA
try {
    $startup = Join-Path $base 'agent\startup'
    $dist = Join-Path $base 'agent\dist'
    New-Item -ItemType Directory -Force $startup, $dist | Out-Null
    Copy-Item -LiteralPath $Launcher -Destination (Join-Path $startup 'windows-launch.ps1')
    Copy-Item -LiteralPath (Join-Path (Split-Path $Launcher) 'windows-hidden.vbs') -Destination $startup
    Set-Content -LiteralPath (Join-Path $dist 'main.js') -Value 'console.error("safe warning"); console.log("still running");' -Encoding ASCII
    $env:LOCALAPPDATA = Join-Path $base 'local'
    $node = (Get-Command node.exe).Source
    & cscript.exe //B //NoLogo (Join-Path $startup 'windows-hidden.vbs') $node
    if ($LASTEXITCODE -ne 0) { throw 'Launcher failed on standard error.' }
    $log = Get-Content -Raw (Join-Path $env:LOCALAPPDATA 'NeonByte\agent.log')
    if ($log -notmatch 'safe warning' -or $log -notmatch 'still running') { throw 'Launcher did not capture both streams.' }
    Set-Content -LiteralPath (Join-Path $dist 'main.js') -Value 'console.error("safe failure"); process.exit(7);' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $base '.env') -Value 'NEONBYTE_TEST=enabled' -Encoding ASCII
    & cscript.exe //B //NoLogo (Join-Path $startup 'windows-hidden.vbs') $node
    if ($LASTEXITCODE -ne 7) { throw 'Launcher did not propagate the failure exit code.' }
    Write-Output 'Windows launcher warning, logging, configuration, and failure tests passed.' 
} finally {
    $env:LOCALAPPDATA = $oldLocalAppData
    Remove-Item -Recurse -Force -LiteralPath $base -ErrorAction SilentlyContinue
}
