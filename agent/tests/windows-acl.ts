import { execFileSync } from "node:child_process";

const aclScript = [
  "$ErrorActionPreference = 'Stop'",
  "$path = $env:NEONBYTE_TEST_ACL_PATH",
  "$acl = Get-Acl -LiteralPath $path",
  "$item = Get-Item -LiteralPath $path -Force",
  "$inheritance = if ($item.PSIsContainer) { [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [System.Security.AccessControl.InheritanceFlags]::None }",
  "if ($env:NEONBYTE_TEST_ACL_MODE -eq 'restrict') {",
  "$acl.SetAccessRuleProtection($true, $false)",
  "$sids = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')",
  "foreach ($sid in $sids) { $identity = [System.Security.Principal.SecurityIdentifier]::new($sid); $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule) }",
  "} else { $identity = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule) }",
  "Set-Acl -LiteralPath $path -AclObject $acl",
].join("\n");

function setWindowsAcl(path: string, mode: "restrict" | "broaden"): void {
  if (process.platform !== "win32") return;
  execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", aclScript], {
    windowsHide: true,
    env: { ...process.env, NEONBYTE_TEST_ACL_PATH: path, NEONBYTE_TEST_ACL_MODE: mode },
  });
}

export function restrictWindowsAcl(path: string): void { setWindowsAcl(path, "restrict"); }
export function broadenWindowsAcl(path: string): void { setWindowsAcl(path, "broaden"); }
