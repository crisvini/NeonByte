import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Windows task uses a waiting hidden launcher and updates the existing task', () => {
  const register = read('../agent/startup/windows-register.ps1');
  const launcher = read('../agent/startup/windows-hidden.vbs');
  assert.match(register, /wscript\.exe/i);
  assert.match(register, /windows-hidden\.vbs/i);
  assert.match(register, /Register-ScheduledTask[^\n]*-Force/);
  assert.match(launcher, /\.Run\s*\(.*?,\s*0\s*,\s*True\)/i);
  assert.match(launcher, /WScript\.Quit/i);
});

test('Windows hidden launch chain handles paths with spaces and forwards child output and exit status', (context) => {
  if (process.platform !== 'win32') {
    context.skip('requires Windows PowerShell and Windows Script Host');
    return;
  }

  const testScript = fileURLToPath(new URL('../agent/tests/windows-launch.test.ps1', import.meta.url));
  const launcher = fileURLToPath(new URL('../agent/startup/windows-launch.ps1', import.meta.url));
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    testScript,
    '-Launcher',
    launcher,
  ], { encoding: 'utf8', timeout: 60_000 });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Windows launcher warning, logging, configuration, and failure tests passed\./);
});
