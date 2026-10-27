param(
    [Parameter(Mandatory = $true)][string]$Distribution,
    [Parameter(Mandatory = $true)][string]$LinuxUser,
    [Parameter(Mandatory = $true)][string]$CheckoutPath,
    [Parameter(Mandatory = $true)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
# Restrict arguments so WSL command-line conversion cannot reinterpret them.
if ($Distribution -notmatch '^[A-Za-z0-9_.-]+$' -or $LinuxUser -notmatch '^[A-Za-z0-9_.-]+$' -or
    $CheckoutPath -notmatch '^/[A-Za-z0-9_./-]+$' -or $NodePath -notmatch '^/[A-Za-z0-9_./-]+$') {
    throw 'Use simple distribution and user names and absolute Linux paths without spaces.'
}
& "$env:WINDIR\System32\wsl.exe" --distribution $Distribution --user $LinuxUser --exec /bin/sh "$CheckoutPath/agent/startup/wsl-launch.sh" $CheckoutPath $NodePath
exit $LASTEXITCODE
