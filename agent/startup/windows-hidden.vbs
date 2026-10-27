Option Explicit

Dim shell, files, scriptPath, nodePath, command, exitCode
If WScript.Arguments.Count <> 1 Then WScript.Quit 1
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
scriptPath = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "windows-launch.ps1")
nodePath = WScript.Arguments(0)
command = """" & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & scriptPath & """ -NodePath """ & nodePath & """"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
