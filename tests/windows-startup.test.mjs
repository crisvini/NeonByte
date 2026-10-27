import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
