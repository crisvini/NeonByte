param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$node = (Resolve-Path -LiteralPath $NodePath).Path
$launcher = Join-Path $PSScriptRoot 'windows-hidden.vbs'
if ($node.Contains('"') -or $launcher.Contains('"')) { throw 'Paths cannot contain quotation marks.' }
$arguments = '//B //NoLogo "' + $launcher + '" "' + $node + '"'
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -Principal $principal -TaskName 'NeonByte Agent' -Action $action -Trigger $trigger -Settings $settings -Description 'Starts the NeonByte agent at user login.' -Force
