param([Parameter(Mandatory = $true)][string]$Launcher)
$ErrorActionPreference = 'Stop'
$base = Join-Path ([IO.Path]::GetTempPath()) ('neonbyte startup with spaces-' + [guid]::NewGuid())
$oldLocalAppData = $env:LOCALAPPDATA
try {
    $startup = Join-Path $base 'agent\startup'
    $dist = Join-Path $base 'agent\dist'
    $runtime = Join-Path $base 'node runtime'
    New-Item -ItemType Directory -Force $startup, $dist, $runtime | Out-Null
    Copy-Item -LiteralPath $Launcher -Destination (Join-Path $startup 'windows-launch.ps1')
    Copy-Item -LiteralPath (Join-Path (Split-Path $Launcher) 'windows-hidden.vbs') -Destination $startup
    Set-Content -LiteralPath (Join-Path $dist 'main.js') -Value 'console.error("safe warning"); console.log("still running"); console.log("env:" + (process.env.NEONBYTE_TEST ?? "missing"));' -Encoding ASCII
    $env:LOCALAPPDATA = Join-Path $base 'local'
    $node = Join-Path $runtime 'node.exe'
    Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination $node
    & cscript.exe //B //NoLogo (Join-Path $startup 'windows-hidden.vbs') $node
    if ($LASTEXITCODE -ne 0) { throw 'Launcher failed on standard error.' }
    $log = Get-Content -Raw (Join-Path $env:LOCALAPPDATA 'NeonByte\agent.log')
    if ($log -notmatch 'safe warning' -or $log -notmatch 'still running' -or $log -notmatch 'env:missing') { throw 'Launcher did not capture both streams or run without an optional .env file.' }
    Set-Content -LiteralPath (Join-Path $dist 'main.js') -Value 'console.error("safe failure"); console.log("env:" + (process.env.NEONBYTE_TEST ?? "missing")); process.exit(7);' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $base '.env') -Value 'NEONBYTE_TEST=enabled' -Encoding ASCII
    & cscript.exe //B //NoLogo (Join-Path $startup 'windows-hidden.vbs') $node
    if ($LASTEXITCODE -ne 7) { throw 'Launcher did not propagate the failure exit code.' }
    $log = Get-Content -Raw (Join-Path $env:LOCALAPPDATA 'NeonByte\agent.log')
    if ($log -notmatch 'env:enabled') { throw "Launcher did not load .env from a path containing spaces. Captured log: $log" }
    Write-Output 'Windows launcher warning, logging, configuration, and failure tests passed.' 
} finally {
    $env:LOCALAPPDATA = $oldLocalAppData
    Remove-Item -Recurse -Force -LiteralPath $base -ErrorAction SilentlyContinue
}
